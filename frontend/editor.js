import * as A from "@automerge/automerge";
import { basicSetup, EditorView } from "codemirror";
import { Decoration, keymap } from "@codemirror/view";
import { Compartment, EditorState, Prec, StateEffect, StateField, Transaction } from "@codemirror/state";
import { indentWithTab } from "@codemirror/commands";
import { HighlightStyle, StreamLanguage, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { python } from "@codemirror/lang-python";
import { markdown } from "@codemirror/lang-markdown";
import { json } from "@codemirror/lang-json";
import { javascript } from "@codemirror/lang-javascript";
import { cpp } from "@codemirror/lang-cpp";
import { java } from "@codemirror/lang-java";
import { html } from "@codemirror/lang-html";
import MarkdownIt from "markdown-it";
import markdownItKatexModule from "@vscode/markdown-it-katex";
import katex from "katex";

function bytesToB64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function b64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export class CollabSession {
  constructor(doc) {
    this.doc = doc;
  }

  static fromBase64(docBase64) {
    return new CollabSession(A.load(b64ToBytes(docBase64)));
  }

  static create(fileId, text = "") {
    return new CollabSession(A.from({ fileId: String(fileId || ""), text: String(text ?? "") }));
  }

  get text() {
    return typeof this.doc?.text === "string" ? this.doc.text : "";
  }

  toBase64() {
    return bytesToB64(A.save(this.doc));
  }

  applyLocalText(nextText) {
    const str = String(nextText ?? "");
    if (this.text === str) {
      return { changed: false, changesBase64: [], docBase64: this.toBase64(), text: str };
    }
    const prev = this.doc;
    const next = A.change(prev, (draft) => {
      A.updateText(draft, ["text"], str);
    });
    const changes = A.getChanges(prev, next);
    this.doc = next;
    return {
      changed: true,
      changesBase64: changes.map((c) => bytesToB64(c)),
      docBase64: bytesToB64(A.save(next)),
      text: next.text,
    };
  }

  applyRemotePatch({ changesBase64, docBase64, text } = {}) {
    let next = this.doc;
    let appliedOk = false;
    if (Array.isArray(changesBase64) && changesBase64.length > 0) {
      try {
        const decoded = changesBase64.map((c) => b64ToBytes(c));
        const [applied] = A.applyChanges(next, decoded);
        next = applied;
        appliedOk = true;
      } catch {
        appliedOk = false;
      }
    }
    if (docBase64) {
      try {
        const remote = A.load(b64ToBytes(docBase64));
        if (!appliedOk) {
          next = A.merge(next, remote);
          appliedOk = true;
        } else {
          const heads = new Set(A.getHeads(next));
          const missing = A.getHeads(remote).some((h) => !heads.has(h));
          if (missing) next = A.merge(next, remote);
        }
      } catch {
        // Ignore malformed fallback doc
      }
    }
    if (!appliedOk && typeof text === "string" && next.text !== text) {
      next = A.change(next, (draft) => {
        A.updateText(draft, ["text"], text);
      });
    }
    this.doc = next;
    return next.text;
  }
}

const leanKeywords = new Set(("abbrev axiom by calc case cases class def deriving do else end example " +
  "exact forall fun have if import in inductive instance intro let match mutual namespace noncomputable " +
  "notation opaque open private public return rw section set_option show simp structure theorem then " +
  "universe variable where with rcases constructor left right positivity induction").split(" "));

const lean = StreamLanguage.define({
  startState: () => ({ commentDepth: 0 }),
  token(stream, state) {
    if (state.commentDepth || stream.match("/-")) {
      if (!state.commentDepth) state.commentDepth = 1;
      while (!stream.eol() && state.commentDepth) {
        if (stream.match("/-")) state.commentDepth++;
        else if (stream.match("-/")) state.commentDepth--;
        else stream.next();
      }
      return "comment";
    }
    if (stream.eatSpace()) return null;
    if (stream.match("--")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match(/"(?:[^"\\]|\\.)*(?:"|$)/)) return "string";
    if (stream.match(/#(?:check|print|eval|reduce|guard_msgs)\b/)) return "meta";
    if (stream.match(/\d[\d_]*/)) return "number";
    if (stream.match(/[\p{L}_][\p{L}\p{N}_'′₀-₉]*/u)) {
      const word = stream.current();
      return leanKeywords.has(word) ? "keyword" : /^\p{Lu}/u.test(word) ? "typeName" : "variableName";
    }
    if (stream.match(/[:=<>+*\/→←↔∀∃∧∨¬≠≤≥|^-]+/u)) return "operator";
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: "--", block: { open: "/-", close: "-/" } } },
});

const categoryKeywords = new Set([
  "category", "object", "objects", "morphism", "hom", "iso", "terminal", "initial",
  "product", "coproduct", "functor", "nat", "adjunction", "unit", "counit", "of", "in",
  "axiom", "theorem", "lemma", "example", "by", "id", "inv",
  "id_left", "id_right", "simp_id", "assoc", "assoc_left", "assoc_right",
  "functor_id", "functor_comp", "functor_merge", "naturality",
  "product_beta", "product_eta", "coproduct_beta", "coproduct_eta",
  "iso_cancel", "terminal_uniq", "initial_uniq", "zig", "zag",
  "rw", "rewrite", "symm", "normalize", "simp", "rfl", "qed",
]);

const categoryLang = StreamLanguage.define({
  startState: () => ({ comment: 0 }),
  token(stream, state) {
    if (state.comment > 0) {
      while (!stream.eol()) {
        if (stream.match("/-")) state.comment++;
        else if (stream.match("-/")) {
          state.comment--;
          if (state.comment === 0) return "comment";
        } else stream.next();
      }
      return "comment";
    }
    if (stream.eatSpace()) return null;
    if (stream.match("--")) { stream.skipToEnd(); return "comment"; }
    if (stream.match("/-")) { state.comment = 1; return "comment"; }
    if (stream.match(/[⟨⟩\[\]()∘→↔≅⇒⊣]/u)) return "operator";
    if (stream.match(/[\p{L}_][\p{L}\p{N}_'₀-₉]*/u)) {
      const word = stream.current();
      return categoryKeywords.has(word) ? "keyword" : /^\p{Lu}/.test(word) ? "typeName" : "variableName";
    }
    if (stream.match(/[:=<>+\-*|.,!?]+/u)) return "operator";
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: "--", block: { open: "/-", close: "-/" } } },
});

const languages = {
  lean4: lean,
  category: categoryLang,
  python: python(),
  markdown: markdown(),
  json: json(),
  javascript: javascript({ jsx: true }),
  typescript: javascript({ typescript: true, jsx: true }),
  cpp: cpp(),
  java: java(),
  html: html(),
};

const darkTheme = [
  EditorView.theme({
    "&": { color: "#e5e7eb", backgroundColor: "#141413", fontSize: "13.5px" },
    ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.65", overflow: "auto" },
    ".cm-content": { padding: "10px 0", caretColor: "#faf9f6" },
    ".cm-line": { padding: "0 14px" },
    ".cm-gutters": { color: "#78756c", backgroundColor: "#1b1b19", borderRight: "1px solid #2e2d2a" },
    ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "rgba(250, 249, 246, 0.05)" },
    ".cm-exec-line": { backgroundColor: "rgba(251, 191, 36, 0.16)", boxShadow: "inset 3px 0 0 #fbbf24" },
    ".cm-exec-line.cm-exec-solved": { backgroundColor: "rgba(52, 211, 153, 0.16)", boxShadow: "inset 3px 0 0 #34d399" },
    ".cm-exec-line.cm-exec-error": { backgroundColor: "rgba(251, 113, 133, 0.18)", boxShadow: "inset 3px 0 0 #fb7185" },
    ".cm-exec-line.cm-exec-lean": { backgroundColor: "rgba(167, 139, 250, 0.2)", boxShadow: "inset 3px 0 0 #a78bfa" },
    ".cm-selectionBackground": { backgroundColor: "rgba(167, 139, 250, 0.28) !important" },
    "&.cm-focused": { outline: "none" },
    ".cm-cursor": { borderLeftColor: "#faf9f6" },
  }, { dark: true }),
  syntaxHighlighting(HighlightStyle.define([
    { tag: [tags.keyword, tags.modifier, tags.definitionKeyword], color: "#d8b4fe" },
    { tag: [tags.string, tags.special(tags.string)], color: "#a7f3d0" },
    { tag: [tags.number, tags.literal, tags.bool], color: "#fde68a" },
    { tag: [tags.typeName, tags.className, tags.namespace], color: "#93c5fd" },
    { tag: [tags.comment, tags.docComment], color: "#8c8980", fontStyle: "italic" },
    { tag: [tags.operator, tags.meta], color: "#cbd5e1" },
    { tag: tags.heading, color: "#faf9f6", fontWeight: "bold" },
    { tag: [tags.link, tags.url], color: "#93c5fd" },
  ])),
];

const lightTheme = [
  EditorView.theme({
    "&": { color: "#141413", backgroundColor: "#ffffff", fontSize: "13.5px" },
    ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.65", overflow: "auto" },
    ".cm-content": { padding: "10px 0", caretColor: "#141413" },
    ".cm-line": { padding: "0 14px" },
    ".cm-gutters": { color: "#8c8980", backgroundColor: "#faf9f6", borderRight: "1px solid rgba(20, 20, 19, 0.09)" },
    ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "rgba(20, 20, 19, 0.035)" },
    ".cm-exec-line": { backgroundColor: "rgba(217, 119, 6, 0.12)", boxShadow: "inset 3px 0 0 #d97706" },
    ".cm-exec-line.cm-exec-solved": { backgroundColor: "rgba(5, 150, 105, 0.12)", boxShadow: "inset 3px 0 0 #059669" },
    ".cm-exec-line.cm-exec-error": { backgroundColor: "rgba(220, 38, 38, 0.12)", boxShadow: "inset 3px 0 0 #dc2626" },
    ".cm-exec-line.cm-exec-lean": { backgroundColor: "rgba(79, 70, 229, 0.10)", boxShadow: "inset 3px 0 0 #4f46e5" },
    ".cm-selectionBackground": { backgroundColor: "rgba(20, 20, 19, 0.14) !important" },
    "&.cm-focused": { outline: "none" },
    ".cm-cursor": { borderLeftColor: "#141413" },
  }, { dark: false }),
  syntaxHighlighting(HighlightStyle.define([
    { tag: [tags.keyword, tags.modifier, tags.definitionKeyword], color: "#5b21b6", fontWeight: "600" },
    { tag: [tags.string, tags.special(tags.string)], color: "#166534" },
    { tag: [tags.number, tags.literal, tags.bool], color: "#b45309" },
    { tag: [tags.typeName, tags.className, tags.namespace], color: "#0f766e" },
    { tag: [tags.comment, tags.docComment], color: "#8c8980", fontStyle: "italic" },
    { tag: [tags.operator, tags.meta], color: "#3f3f46" },
    { tag: tags.heading, color: "#141413", fontWeight: "bold" },
    { tag: [tags.link, tags.url], color: "#1d4ed8" },
  ])),
];

const setExecLine = StateEffect.define();
const execLineField = StateField.define({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setExecLine)) {
        const spec = effect.value;
        if (!spec || !spec.line || spec.line < 1 || spec.line > tr.state.doc.lines) {
          next = Decoration.none;
        } else {
          const line = tr.state.doc.line(spec.line);
          const cls = "cm-exec-line" + (spec.kind ? " cm-exec-" + spec.kind : "");
          next = Decoration.set([Decoration.line({ class: cls }).range(line.from)]);
        }
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

function computeMinimalPatch(prev, next) {
  let start = 0;
  const minLen = Math.min(prev.length, next.length);
  while (start < minLen && prev.charCodeAt(start) === next.charCodeAt(start)) {
    start++;
  }
  let endPrev = prev.length;
  let endNext = next.length;
  while (endPrev > start && endNext > start && prev.charCodeAt(endPrev - 1) === next.charCodeAt(endNext - 1)) {
    endPrev--;
    endNext--;
  }
  return { from: start, to: endPrev, insert: next.slice(start, endNext) };
}

export class CodeEditor {
  constructor(options) {
    this.options = options;
    this.config = new Compartment();
    this.themeConfig = new Compartment();
    this.view = new EditorView({
      state: EditorState.create({
        doc: options.text,
        extensions: [
          basicSetup,
          this.themeConfig.of(options.theme === "dark" ? darkTheme : lightTheme),
          execLineField,
          Prec.high(keymap.of([{ key: "Shift-Enter", run: () => Boolean(this.options.onRun?.()) }, indentWithTab])),
          this.config.of(this.extensions(options)),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !this.replacing) this.options.onChange(update.state.doc.toString());
            if (update.selectionSet && this.options.onCursorLine) {
              const isUserEvent = update.transactions.some((tr) =>
                tr.isUserEvent("select") || tr.isUserEvent("select.pointer")
                || tr.isUserEvent("input") || tr.isUserEvent("delete") || tr.isUserEvent("move"),
              );
              if (!isUserEvent && this.replacing) return;
              const head = update.state.selection.main.head;
              const lineInfo = update.state.doc.lineAt(head);
              const col = head - lineInfo.from;
              if (lineInfo.number !== this.lastCursorLine || col !== this.lastCursorCol) {
                this.lastCursorLine = lineInfo.number;
                this.lastCursorCol = col;
                this.options.onCursorLine(lineInfo.number, col, isUserEvent);
              }
            }
          }),
          EditorView.domEventHandlers({
            pointerup: (event, view) => {
              if (!this.options.onCursorLine || event.button !== 0) return;
              requestAnimationFrame(() => {
                const head = view.state.selection.main.head;
                const lineInfo = view.state.doc.lineAt(head);
                const col = head - lineInfo.from;
                this.lastCursorLine = lineInfo.number;
                this.lastCursorCol = col;
                this.options.onCursorLine(lineInfo.number, col, true);
              });
            },
          }),
        ],
      }),
    });
  }

  setHighlightLine(lineNumber, kind = "active", scroll = false) {
    if (!lineNumber || lineNumber < 1 || lineNumber > this.view.state.doc.lines) {
      this.view.dispatch({ effects: setExecLine.of(null) });
      return;
    }
    const line = this.view.state.doc.line(lineNumber);
    const spec = { effects: setExecLine.of({ line: lineNumber, kind }) };
    if (scroll) spec.effects = [spec.effects, EditorView.scrollIntoView(line.from, { y: "center" })];
    this.view.dispatch(spec);
  }

  extensions(options) {
    return [
      languages[options.language] || [],
      indentUnit.of(options.language === "python" ? "    " : "  "),
      EditorState.readOnly.of(options.readOnly),
      EditorView.editable.of(!options.readOnly),
      EditorView.contentAttributes.of({ "aria-label": options.label, spellcheck: "false" }),
      options.language === "markdown" ? EditorView.lineWrapping : [],
    ];
  }

  update(options) {
    const previous = this.options;
    this.options = options;
    const effects = [];
    if (options.language !== previous.language || options.readOnly !== previous.readOnly ||
        options.label !== previous.label) {
      effects.push(this.config.reconfigure(this.extensions(options)));
    }
    if (options.theme !== previous.theme) {
      effects.push(this.themeConfig.reconfigure(options.theme === "dark" ? darkTheme : lightTheme));
    }
    if (effects.length) {
      this.view.dispatch({ effects });
    }
    const { doc } = this.view.state;
    const currentText = doc.toString();
    if (currentText !== options.text) {
      this.replacing = true;
      try {
        const patch = options.minimalDiff
          ? computeMinimalPatch(currentText, options.text)
          : { from: 0, to: doc.length, insert: options.text };
        this.view.dispatch({
          changes: patch,
          annotations: Transaction.addToHistory.of(false),
        });
      } finally {
        this.replacing = false;
      }
    }
  }
}

const markdownItKatex = markdownItKatexModule.default || markdownItKatexModule;
const renderer = new MarkdownIt({ html: false, linkify: true, breaks: false })
  .use(markdownItKatex, { throwOnError: false, errorColor: "#b91c1c", enableBareBlocks: true });

export function renderMarkdown(target, source, options = {}) {
  const template = document.createElement("template");
  template.innerHTML = renderer.render(source);
  for (const link of template.content.querySelectorAll("a[href]")) {
    if (!link.getAttribute("href").startsWith("#")) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
  }
  // Template content is inert, so relative images can be rewritten before the browser fetches them.
  const pending = [];
  if (options.resolveImage) {
    for (const image of template.content.querySelectorAll("img[src]")) {
      const src = image.getAttribute("src");
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src)) continue;
      image.removeAttribute("src");
      pending.push([image, src]);
    }
  }
  target.replaceChildren(template.content);
  for (const [image, src] of pending) options.resolveImage(image, src);
}

/* ---------------- LaTeX document preview ----------------
 * A forgiving LaTeX → HTML renderer for learning notes: structure, lists, tables,
 * theorem-like environments and KaTeX math. Unknown commands keep their argument
 * text instead of failing, so a document with exotic packages still previews.
 */
const LATEX_SYMBOLS = {
  LaTeX: "LaTeX", TeX: "TeX", ldots: "…", dots: "…", textbackslash: "\\", S: "§", P: "¶", copyright: "©",
  quad: " ", qquad: "  ", noindent: "", centering: "", newpage: "", clearpage: "", today: new Date().toLocaleDateString(),
  "&": "&", "%": "%", "$": "$", "#": "#", "_": "_", "{": "{", "}": "}", ",": " ", ";": " ", " ": " ", "-": "­", "\\": "",
};
const IGNORED_ENVS = new Set(["document", "center", "flushleft", "flushright", "minipage", "figure", "table", "small", "footnotesize", "large", "Large"]);
const MATH_ENVS = new Set(["equation", "equation*", "align", "align*", "gather", "gather*", "multline", "multline*", "eqnarray", "eqnarray*", "displaymath", "math"]);
const THEOREM_ENVS = { theorem: "정리", lemma: "보조정리", corollary: "따름정리", proposition: "명제", definition: "정의", example: "예", remark: "참고", proof: "증명", exercise: "연습문제", claim: "주장" };

function stripLatexComments(source) {
  return source.replace(/(^|[^\\])%.*$/gm, "$1");
}

function readGroup(src, i, open = "{", close = "}") {
  // src[i] === open; returns [content, indexAfterClose]
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "\\") { j++; continue; }
    if (src[j] === open) depth++;
    else if (src[j] === close && --depth === 0) return [src.slice(i + 1, j), j + 1];
  }
  return [src.slice(i + 1), src.length];
}

function mathNode(tex, display) {
  const span = document.createElement(display ? "div" : "span");
  span.className = display ? "latex-display" : "latex-inline";
  try {
    katex.render(tex, span, { displayMode: display, throwOnError: false, errorColor: "#b91c1c", trust: false, strict: "ignore" });
  } catch {
    span.textContent = tex;
  }
  return span;
}

class LatexRenderer {
  constructor(source) {
    this.src = stripLatexComments(source);
    this.meta = { title: "", author: "", date: "" };
    this.counters = { section: 0, subsection: 0, subsubsection: 0, equation: 0, theorem: 0 };
    this.footnotes = [];
  }

  render(target) {
    const docStart = this.src.indexOf("\\begin{document}");
    const preamble = docStart >= 0 ? this.src.slice(0, docStart) : "";
    for (const key of ["title", "author", "date"]) {
      const m = preamble.match(new RegExp("\\\\" + key + "\\s*\\{"));
      if (m) this.meta[key] = readGroup(preamble, m.index + m[0].length - 1)[0];
    }
    let body = docStart >= 0 ? this.src.slice(docStart + "\\begin{document}".length) : this.src;
    const end = body.indexOf("\\end{document}");
    if (end >= 0) body = body.slice(0, end);
    const article = document.createElement("article");
    article.className = "latex-doc";
    this.block(body, article);
    if (this.footnotes.length) {
      const list = document.createElement("ol");
      list.className = "latex-footnotes";
      for (const note of this.footnotes) { const li = document.createElement("li"); this.inline(note, li); list.append(li); }
      article.append(list);
    }
    target.replaceChildren(article);
  }

  block(src, parent) {
    // Split into paragraphs on blank lines, but keep environments intact.
    let i = 0;
    let para = "";
    const flush = () => {
      if (para.trim()) {
        const p = document.createElement("p");
        this.inline(para.trim(), p);
        if (p.childNodes.length) parent.append(p);
      }
      para = "";
    };
    while (i < src.length) {
      if (src.startsWith("\n\n", i) || /^\n[ \t]*\n/.test(src.slice(i, i + 40))) {
        flush();
        i = src.indexOf("\n", i + 1) + 1 || src.length;
        continue;
      }
      if (src.startsWith("\\begin{", i)) {
        const [env, after] = readGroup(src, i + 6);
        const close = this.findEnd(src, env, after);
        const inner = src.slice(after, close);
        const next = close + `\\end{${env}}`.length;
        if (MATH_ENVS.has(env) || env === "verbatim" || env === "lstlisting" || env === "minted" || env === "itemize" || env === "enumerate" || env === "description" ||
            env === "tabular" || env === "quote" || env === "quotation" || env === "abstract" || THEOREM_ENVS[env] || IGNORED_ENVS.has(env)) {
          flush();
          this.environment(env, inner, parent);
        } else {
          para += inner;  // unknown environment: keep its text
        }
        i = next;
        continue;
      }
      if (src.startsWith("\\[", i) || src.startsWith("$$", i)) {
        const closer = src.startsWith("\\[", i) ? "\\]" : "$$";
        const end = src.indexOf(closer, i + 2);
        flush();
        parent.append(mathNode(src.slice(i + 2, end < 0 ? src.length : end), true));
        i = end < 0 ? src.length : end + 2;
        continue;
      }
      const heading = /^\\(part|chapter|section|subsection|subsubsection|paragraph)(\*?)\s*(?:\[[^\]]*\])?\s*\{/.exec(src.slice(i, i + 80));
      if (heading) {
        flush();
        const [title, after] = readGroup(src, i + heading[0].length - 1);
        this.heading(heading[1], heading[2] === "*", title, parent);
        i = after;
        continue;
      }
      if (src.startsWith("\\maketitle", i)) {
        flush();
        this.titleBlock(parent);
        i += "\\maketitle".length;
        continue;
      }
      if (/^\\(tableofcontents|documentclass|usepackage|label|newcommand|renewcommand|DeclareMathOperator|setlength|geometry|bibliographystyle|bibliography|pagestyle|thispagestyle|newtheorem)\b/.test(src.slice(i, i + 30))) {
        // skip the command and its arguments
        const m = /^\\[A-Za-z]+\*?/.exec(src.slice(i));
        let j = i + m[0].length;
        while (src[j] === "[" || src[j] === "{" || (src[j] === " " && (src[j + 1] === "{" || src[j + 1] === "["))) {
          if (src[j] === " ") { j++; continue; }
          j = readGroup(src, j, src[j], src[j] === "[" ? "]" : "}")[1];
        }
        i = j;
        continue;
      }
      para += src[i];
      i++;
    }
    flush();
  }

  findEnd(src, env, from) {
    const open = `\\begin{${env}}`;
    const close = `\\end{${env}}`;
    let depth = 1;
    let i = from;
    while (i < src.length) {
      const o = src.indexOf(open, i);
      const c = src.indexOf(close, i);
      if (c < 0) return src.length;
      if (o >= 0 && o < c) { depth++; i = o + open.length; continue; }
      if (--depth === 0) return c;
      i = c + close.length;
    }
    return src.length;
  }

  heading(kind, starred, title, parent) {
    const level = { part: 1, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5 }[kind];
    const h = document.createElement("h" + level);
    if (!starred && ["section", "subsection", "subsubsection"].includes(kind)) {
      const c = this.counters;
      if (kind === "section") { c.section++; c.subsection = 0; c.subsubsection = 0; }
      if (kind === "subsection") { c.subsection++; c.subsubsection = 0; }
      if (kind === "subsubsection") c.subsubsection++;
      const number = kind === "section" ? `${c.section}` : kind === "subsection" ? `${c.section}.${c.subsection}` : `${c.section}.${c.subsection}.${c.subsubsection}`;
      const num = document.createElement("span");
      num.className = "latex-secnum";
      num.textContent = number;
      h.append(num, " ");
    }
    this.inline(title, h);
    parent.append(h);
  }

  titleBlock(parent) {
    const header = document.createElement("header");
    header.className = "latex-title";
    for (const [key, tag] of [["title", "h1"], ["author", "p"], ["date", "p"]]) {
      const value = key === "date" && !this.meta.date ? "\\today" : this.meta[key];
      if (!value) continue;
      const node = document.createElement(tag);
      node.className = "latex-" + key;
      this.inline(value.replace(/\\and\b/g, " · "), node);
      header.append(node);
    }
    parent.append(header);
  }

  environment(env, inner, parent) {
    if (MATH_ENVS.has(env)) {
      let tex = inner.replace(/\\label\{[^}]*\}/g, "").replace(/\\nonumber|\\notag/g, "");
      if (/^(align|eqnarray|multline)/.test(env)) tex = `\\begin{aligned}${tex}\\end{aligned}`;
      if (/^gather/.test(env)) tex = `\\begin{gathered}${tex}\\end{gathered}`;
      const wrap = document.createElement("div");
      wrap.className = "latex-equation";
      wrap.append(mathNode(tex, true));
      if (!env.endsWith("*") && env !== "displaymath" && env !== "math") {
        const tag = document.createElement("span");
        tag.className = "latex-eqno";
        tag.textContent = `(${++this.counters.equation})`;
        wrap.append(tag);
      }
      parent.append(wrap);
      return;
    }
    if (env === "verbatim" || env === "lstlisting" || env === "minted") {
      const pre = document.createElement("pre");
      pre.className = "latex-verbatim";
      pre.textContent = inner.replace(/^(\[[^\]]*\]|\{[^}]*\})+/, "").replace(/^\n/, "");
      parent.append(pre);
      return;
    }
    if (env === "itemize" || env === "enumerate" || env === "description") {
      const list = document.createElement(env === "enumerate" ? "ol" : env === "description" ? "dl" : "ul");
      const items = this.splitItems(inner);
      for (const [labelText, body] of items) {
        if (env === "description") {
          const dt = document.createElement("dt");
          this.inline(labelText || "", dt);
          const dd = document.createElement("dd");
          this.block(body, dd);
          list.append(dt, dd);
        } else {
          const li = document.createElement("li");
          this.block(body, li);
          if (li.children.length === 1 && li.firstElementChild.tagName === "P") li.replaceChildren(...li.firstElementChild.childNodes);
          list.append(li);
        }
      }
      parent.append(list);
      return;
    }
    if (env === "tabular") {
      const table = document.createElement("table");
      table.className = "latex-table";
      const body = inner.replace(/^\s*\{[^}]*\}/, "");
      for (const rowText of body.split(/\\\\/)) {
        const clean = rowText.replace(/\\(hline|toprule|midrule|bottomrule|cline\{[^}]*\})/g, "").trim();
        if (!clean) continue;
        const tr = document.createElement("tr");
        for (const cell of clean.split(/(?<!\\)&/)) {
          const td = document.createElement("td");
          this.inline(cell.trim(), td);
          tr.append(td);
        }
        table.append(tr);
      }
      parent.append(table);
      return;
    }
    if (env === "quote" || env === "quotation" || env === "abstract") {
      const box = document.createElement(env === "abstract" ? "section" : "blockquote");
      box.className = "latex-" + env;
      if (env === "abstract") { const h = document.createElement("h4"); h.textContent = "초록 (Abstract)"; box.append(h); }
      this.block(inner, box);
      parent.append(box);
      return;
    }
    if (THEOREM_ENVS[env]) {
      const box = document.createElement("section");
      box.className = "latex-theorem latex-" + env;
      let content = inner;
      let note = "";
      const opt = /^\s*\[([^\]]*)\]/.exec(content);
      if (opt) { note = opt[1]; content = content.slice(opt[0].length); }
      const head = document.createElement("strong");
      head.textContent = THEOREM_ENVS[env] + (env === "proof" ? "" : ` ${++this.counters.theorem}`) + (note ? ` (${note})` : "") + ". ";
      box.append(head);
      this.block(content, box);
      if (env === "proof") { const q = document.createElement("span"); q.className = "latex-qed"; q.textContent = "∎"; box.append(q); }
      parent.append(box);
      return;
    }
    this.block(inner, parent);  // structural wrappers (center, figure, …)
  }

  splitItems(inner) {
    const items = [];
    let depth = 0;
    let current = null;
    let i = 0;
    while (i < inner.length) {
      if (inner.startsWith("\\begin{", i)) depth++;
      if (inner.startsWith("\\end{", i)) depth--;
      if (depth === 0 && /^\\item\b/.test(inner.slice(i, i + 6))) {
        if (current) items.push(current);
        i += 5;
        let labelText = "";
        if (inner[i] === "[") { const [l, after] = readGroup(inner, i, "[", "]"); labelText = l; i = after; }
        current = [labelText, ""];
        continue;
      }
      if (current) current[1] += inner[i];
      i++;
    }
    if (current) items.push(current);
    return items;
  }

  inline(src, parent) {
    let text = "";
    const pushText = () => {
      if (text) {
        parent.append(text.replace(/---/g, "—").replace(/--/g, "–").replace(/``/g, "“").replace(/''/g, "”").replace(/~/g, " "));
        text = "";
      }
    };
    let i = 0;
    while (i < src.length) {
      const ch = src[i];
      if (ch === "$") {
        const display = src[i + 1] === "$";
        const start = i + (display ? 2 : 1);
        let end = start;
        while (end < src.length && !(src[end] === "$" && src[end - 1] !== "\\")) end++;
        pushText();
        parent.append(mathNode(src.slice(start, end), display));
        i = end + (display ? 2 : 1);
        continue;
      }
      if (src.startsWith("\\(", i) || src.startsWith("\\[", i)) {
        const display = src[i + 1] === "[";
        const end = src.indexOf(display ? "\\]" : "\\)", i + 2);
        pushText();
        parent.append(mathNode(src.slice(i + 2, end < 0 ? src.length : end), display));
        i = end < 0 ? src.length : end + 2;
        continue;
      }
      if (ch === "\\") {
        const m = /^\\([A-Za-z]+\*?|.)/.exec(src.slice(i));
        const name = m[1];
        i += m[0].length;
        if (name === "\\") { pushText(); parent.append(document.createElement("br")); if (src[i] === "[") i = readGroup(src, i, "[", "]")[1]; continue; }
        if (name in LATEX_SYMBOLS) { text += LATEX_SYMBOLS[name]; if (/^[A-Za-z]/.test(name) && src[i] === " ") i++; continue; }
        while (src[i] === " " && src[i + 1] === "{") i++;
        const wrapTags = { textbf: "strong", bf: "strong", textit: "em", emph: "em", it: "em", textsl: "em", texttt: "code", underline: "u", textsc: "span", textsf: "span", text: "span", mbox: "span", textrm: "span" };
        if (wrapTags[name] && src[i] === "{") {
          const [arg, after] = readGroup(src, i);
          pushText();
          const node = document.createElement(wrapTags[name]);
          if (name === "textsc") node.style.fontVariant = "small-caps";
          this.inline(arg, node);
          parent.append(node);
          i = after;
          continue;
        }
        if ((name === "href") && src[i] === "{") {
          const [url, after] = readGroup(src, i);
          const [label, after2] = src[after] === "{" ? readGroup(src, after) : [url, after];
          pushText();
          const a = document.createElement("a");
          if (/^https?:\/\//.test(url)) { a.href = url; a.target = "_blank"; a.rel = "noopener noreferrer"; }
          this.inline(label, a);
          parent.append(a);
          i = after2;
          continue;
        }
        if (name === "url" && src[i] === "{") {
          const [url, after] = readGroup(src, i);
          pushText();
          const a = document.createElement("a");
          if (/^https?:\/\//.test(url)) { a.href = url; a.target = "_blank"; a.rel = "noopener noreferrer"; }
          a.textContent = url;
          parent.append(a);
          i = after;
          continue;
        }
        if (name === "footnote" && src[i] === "{") {
          const [note, after] = readGroup(src, i);
          this.footnotes.push(note);
          pushText();
          const sup = document.createElement("sup");
          sup.textContent = String(this.footnotes.length);
          parent.append(sup);
          i = after;
          continue;
        }
        if ((name === "ref" || name === "eqref" || name === "cite" || name === "label" || name === "pageref") && src[i] === "{") {
          const [arg, after] = readGroup(src, i);
          if (name !== "label") text += name === "cite" ? `[${arg}]` : `(${arg})`;
          i = after;
          continue;
        }
        if (name === "includegraphics") {
          if (src[i] === "[") i = readGroup(src, i, "[", "]")[1];
          if (src[i] === "{") {
            const [file, after] = readGroup(src, i);
            pushText();
            const figure = document.createElement("span");
            figure.className = "latex-figure-placeholder";
            figure.textContent = `🖼 ${file}`;
            parent.append(figure);
            i = after;
          }
          continue;
        }
        // Unknown command: drop optional args and render the mandatory argument's text.
        if (src[i] === "[") i = readGroup(src, i, "[", "]")[1];
        if (src[i] === "{") {
          const [arg, after] = readGroup(src, i);
          pushText();
          const span = document.createElement("span");
          this.inline(arg, span);
          parent.append(...span.childNodes);
          i = after;
        }
        continue;
      }
      if (ch === "{" || ch === "}") { i++; continue; }
      text += ch === "\n" ? " " : ch;
      i++;
    }
    pushText();
  }
}

export function renderLatexDocument(target, source) {
  new LatexRenderer(source).render(target);
}

export function renderMath(target, tex, display = true) {
  target.replaceChildren(mathNode(tex, display));
}
