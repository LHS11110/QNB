import { build } from "esbuild";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { cpSync, mkdirSync } from "node:fs";

const require = createRequire(import.meta.url);
const root = new URL(".", import.meta.url).pathname;
const repoRoot = process.env.QNB_OUT_ROOT ? resolve(process.env.QNB_OUT_ROOT) : resolve(root, "..");
const vendorDir = resolve(repoRoot, "qnb/static/vendor");
mkdirSync(vendorDir, { recursive: true });

const amBase = dirname(require.resolve("@automerge/automerge"));
const amFullfat = resolve(amBase, "fullfat_base64.cjs");

await Promise.all([
  build({
    entryPoints: [resolve(root, "editor.js")],
    outfile: resolve(vendorDir, "editor.js"),
    bundle: true,
    minify: true,
    format: "iife",
    globalName: "QNBEditing",
    legalComments: "eof",
    alias: { "@automerge/automerge": amFullfat },
  }),
  build({
    entryPoints: [resolve(root, "graph.js")],
    outfile: resolve(vendorDir, "graph.js"),
    bundle: true,
    minify: true,
    format: "iife",
    globalName: "QNBGraph",
    legalComments: "eof",
  }),
  build({
    entryPoints: [resolve(root, "crdt_daemon.cjs")],
    outfile: resolve(repoRoot, "qnb/crdt_daemon.cjs"),
    bundle: true,
    minify: false,
    platform: "node",
    format: "cjs",
    target: "node22",
    alias: { "@automerge/automerge": amFullfat },
  }),
]);

// KaTeX stylesheet + fonts for math in Markdown / LaTeX previews.
const katexDist = resolve(dirname(require.resolve("katex/package.json")), "dist");
mkdirSync(resolve(vendorDir, "katex"), { recursive: true });
cpSync(resolve(katexDist, "katex.min.css"), resolve(vendorDir, "katex/katex.min.css"));
cpSync(resolve(katexDist, "fonts"), resolve(vendorDir, "katex/fonts"), { recursive: true });
cpSync(resolve(katexDist, "../LICENSE"), resolve(vendorDir, "katex/LICENSE"));
