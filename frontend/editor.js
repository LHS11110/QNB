import { basicSetup, EditorView } from "codemirror";
import { keymap } from "@codemirror/view";
import { Compartment, EditorState, Prec, Transaction } from "@codemirror/state";
import { indentWithTab } from "@codemirror/commands";
import { HighlightStyle, StreamLanguage, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { python } from "@codemirror/lang-python";
import { markdown } from "@codemirror/lang-markdown";
import { json } from "@codemirror/lang-json";
import { javascript } from "@codemirror/lang-javascript";
import MarkdownIt from "markdown-it";

const leanKeywords = new Set(("abbrev axiom by calc case cases class def deriving do else end example " +
  "exact forall fun have if import in inductive instance intro let match mutual namespace noncomputable " +
  "notation opaque open private public return rw section set_option show simp structure theorem then " +
  "universe variable where with").split(" "));
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

const languages = {
  lean4: lean,
  python: python(),
  markdown: markdown(),
  json: json(),
  javascript: javascript({ jsx: true }),
  typescript: javascript({ typescript: true, jsx: true }),
};

const theme = EditorView.theme({
  "&": { color: "#dbe4f3", backgroundColor: "#101827", fontSize: "14px" },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.65", overflow: "auto" },
  ".cm-content": { padding: "8px 0", caretColor: "#bbacff" },
  ".cm-line": { padding: "0 12px" },
  ".cm-gutters": { color: "#8191a9", backgroundColor: "#131e2f", borderRight: "1px solid #26364c" },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "#25344c80" },
  ".cm-selectionBackground": { backgroundColor: "#534981 !important" },
  "&.cm-focused": { outline: "none" },
  ".cm-cursor": { borderLeftColor: "#bbacff" },
}, { dark: true });

const highlight = syntaxHighlighting(HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.definitionKeyword], color: "#c7a9ff" },
  { tag: [tags.string, tags.special(tags.string)], color: "#a8d9aa" },
  { tag: [tags.number, tags.literal, tags.bool], color: "#f7c688" },
  { tag: [tags.typeName, tags.className, tags.namespace], color: "#88dce3" },
  { tag: [tags.comment, tags.docComment], color: "#a0aec5", fontStyle: "italic" },
  { tag: [tags.operator, tags.meta], color: "#bcb4f2" },
  { tag: tags.heading, color: "#e7d5ff", fontWeight: "bold" },
  { tag: [tags.link, tags.url], color: "#99c8ff" },
]));

export class CodeEditor {
  constructor(options) {
    this.options = options;
    this.config = new Compartment();
    this.view = new EditorView({
      state: EditorState.create({
        doc: options.text,
        extensions: [
          basicSetup, theme, highlight,
          Prec.high(keymap.of([{ key: "Shift-Enter", run: () => Boolean(this.options.onRun?.()) }, indentWithTab])),
          this.config.of(this.extensions(options)),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !this.replacing) this.options.onChange(update.state.doc.toString());
          }),
        ],
      }),
    });
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
    if (options.language !== previous.language || options.readOnly !== previous.readOnly ||
        options.label !== previous.label) {
      this.view.dispatch({ effects: this.config.reconfigure(this.extensions(options)) });
    }
    const { doc } = this.view.state;
    if (doc.toString() !== options.text) {
      this.replacing = true;
      try {
        this.view.dispatch({
          changes: { from: 0, to: doc.length, insert: options.text },
          annotations: Transaction.addToHistory.of(false),
        });
      } finally {
        this.replacing = false;
      }
    }
  }
}

const renderer = new MarkdownIt({ html: false, linkify: true, breaks: false });

export function renderMarkdown(target, source) {
  const template = document.createElement("template");
  template.innerHTML = renderer.render(source);
  for (const link of template.content.querySelectorAll("a[href]")) {
    if (!link.getAttribute("href").startsWith("#")) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
  }
  target.replaceChildren(template.content);
}
