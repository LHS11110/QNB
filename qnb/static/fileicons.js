"use strict";

/* Explorer file symbols: recognisable glyphs per format, drawn as inline SVG (18×18). */
(() => {
  const NS = "http://www.w3.org/2000/svg";

  function make(tag, attrs, text) {
    const node = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function label(text, fill, x = 9, y = 9) {
    const size = text.length >= 4 ? 4.4 : text.length === 3 ? 5.2 : text.length === 2 ? 6.4 : 8.6;
    return make("text", {
      x, y, "text-anchor": "middle", "dominant-baseline": "central",
      "font-size": size, "font-weight": "800", "font-family": "ui-monospace, Menlo, monospace",
      "letter-spacing": "-0.3", fill,
    }, text);
  }

  /* ---- glyph painters: each returns a list of SVG nodes ---- */

  const page = (stroke, fill = "none") => [
    make("path", { d: "M4 2.3h6.4L14 5.9v9.3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3.3a1 1 0 0 1 1-1Z", fill, stroke, "stroke-width": "1.3", "stroke-linejoin": "round" }),
    make("path", { d: "M10.4 2.3v3.6H14", stroke, "stroke-width": "1.2", "stroke-linejoin": "round", fill: "none" }),
  ];

  const pageBadge = (stroke, text, fill = "rgba(108,105,96,0.10)") => [
    ...page(stroke, fill), label(text, stroke, 8.6, 11.6),
  ];

  const tile = (bg, text, ink = "#fff") => [
    make("rect", { x: 1.6, y: 1.6, width: 14.8, height: 14.8, rx: 3.2, fill: bg }),
    label(text, ink, 9, 9.6),
  ];

  const hexagon = (bg, text, ink = "#fff") => [
    make("path", { d: "M9 1.3 15.7 5.15v7.7L9 16.7 2.3 12.85v-7.7Z", fill: bg }),
    label(text, ink, 9, 9.2),
  ];

  /* C-family: big letter plus "++" drawn as strokes so it stays legible at 16px. */
  const cfamily = (bg, letter, plus) => [
    make("path", { d: "M9 1.3 15.7 5.15v7.7L9 16.7 2.3 12.85v-7.7Z", fill: bg }),
    label(letter, "#fff", plus ? 6.7 : 9, 9.3),
    ...(plus ? [make("path", {
      d: "M11.4 6.8h2.2M12.5 5.7v2.2M11.4 11.4h2.2M12.5 10.3v2.2",
      stroke: "#fff", "stroke-width": "1", "stroke-linecap": "round",
    })] : []),
  ];

  const git = () => [
    make("path", { d: "M9 1.4 16.6 9 9 16.6 1.4 9Z", fill: "#F05133", "stroke-linejoin": "round" }),
    make("path", { d: "M7.2 5.4v7.2M7.2 7.6c0 1.8 3.6 1.2 3.6 3.2", stroke: "#fff", "stroke-width": "1.25", "stroke-linecap": "round", fill: "none" }),
    make("circle", { cx: 7.2, cy: 5.3, r: 1.15, fill: "#fff" }),
    make("circle", { cx: 7.2, cy: 12.7, r: 1.15, fill: "#fff" }),
    make("circle", { cx: 10.8, cy: 10.9, r: 1.15, fill: "#fff" }),
  ];

  const terminal = (bg, prompt) => [
    make("rect", { x: 1.6, y: 2.6, width: 14.8, height: 12.8, rx: 2.4, fill: bg }),
    make("path", { d: "M4.6 6.6 7.4 9l-2.8 2.4", stroke: prompt, "stroke-width": "1.6", "stroke-linecap": "round", "stroke-linejoin": "round", fill: "none" }),
    make("path", { d: "M8.8 11.6h4.4", stroke: "#fff", "stroke-width": "1.5", "stroke-linecap": "round" }),
  ];

  const python = () => [
    make("path", { d: "M8.8 1.8c-3.3 0-3.1 1.4-3.1 1.4v1.5h3.2v.5H4.4S2 4.9 2 8.6s2.1 3.6 2.1 3.6h1.3v-1.7s-.1-2.1 2.1-2.1h3.5s2 0 2-2V3.8s.3-2-4.2-2Zm-1.9 1.1a.65.65 0 1 1 0 1.3.65.65 0 0 1 0-1.3Z", fill: "#3776AB" }),
    make("path", { d: "M9.2 16.2c3.3 0 3.1-1.4 3.1-1.4v-1.5H9.1v-.5h4.5S16 13.1 16 9.4s-2.1-3.6-2.1-3.6h-1.3v1.7s.1 2.1-2.1 2.1H7s-2 0-2 2v2.6s-.3 2 4.2 2Zm1.9-1.1a.65.65 0 1 1 0-1.3.65.65 0 0 1 0 1.3Z", fill: "#FFC331" }),
  ];

  const jupyter = () => [
    make("path", { d: "M3.3 7.1C4.6 4.4 13.4 4.4 14.7 7.1 13.1 5.6 4.9 5.6 3.3 7.1Z", fill: "#F37726", stroke: "#F37726", "stroke-width": "1.1", "stroke-linejoin": "round" }),
    make("path", { d: "M3.3 10.9c1.3 2.7 10.1 2.7 11.4 0-1.6 1.5-9.8 1.5-11.4 0Z", fill: "#F37726", stroke: "#F37726", "stroke-width": "1.1", "stroke-linejoin": "round" }),
    make("circle", { cx: 14.3, cy: 2.9, r: 1.1, fill: "#767677" }),
    make("circle", { cx: 3.6, cy: 15.1, r: 1.25, fill: "#9E9E9E" }),
    make("circle", { cx: 3.2, cy: 3.4, r: 0.75, fill: "#616262" }),
  ];

  const lua = () => [
    make("circle", { cx: 8.3, cy: 9.7, r: 6.3, fill: "#000080" }),
    make("circle", { cx: 10.4, cy: 7.6, r: 1.75, fill: "#fff" }),
    make("circle", { cx: 15.3, cy: 2.7, r: 1.6, fill: "#000080" }),
  ];

  const image = () => [
    make("rect", { x: 2, y: 3, width: 14, height: 12, rx: 2, fill: "rgba(13,148,136,0.12)", stroke: "#0F766E", "stroke-width": "1.3" }),
    make("circle", { cx: 6.2, cy: 6.9, r: 1.35, fill: "#F59E0B" }),
    make("path", { d: "M2.6 13.4 6.8 9.6l2.6 2.3 2.3-2 3.7 3.5", stroke: "#0F766E", "stroke-width": "1.3", "stroke-linejoin": "round", fill: "none" }),
  ];

  const pdf = () => [
    ...page("#DC2626", "rgba(220,38,38,0.10)"),
    make("rect", { x: 1.2, y: 9.2, width: 11.6, height: 5.4, rx: 1.2, fill: "#DC2626" }),
    label("PDF", "#fff", 7, 12),
  ];

  const markdown = () => [
    make("rect", { x: 1.4, y: 4, width: 15.2, height: 10, rx: 2, fill: "none", stroke: "#0F766E", "stroke-width": "1.3" }),
    make("path", { d: "M3.8 11.4V6.6l1.9 2.2 1.9-2.2v4.8M11.9 6.6v4.6M10.2 9.7l1.7 1.8 1.7-1.8", stroke: "#0F766E", "stroke-width": "1.25", "stroke-linecap": "round", "stroke-linejoin": "round", fill: "none" }),
  ];

  const braces = (color) => [
    make("path", { d: "M6.4 2.8C4.6 2.8 4.8 4.4 4.8 6c0 1.6-1.2 2.4-2 3 .8.6 2 1.4 2 3 0 1.6-.2 3.2 1.6 3.2M11.6 2.8c1.8 0 1.6 1.6 1.6 3.2 0 1.6 1.2 2.4 2 3-.8.6-2 1.4-2 3 0 1.6.2 3.2-1.6 3.2", stroke: color, "stroke-width": "1.45", "stroke-linecap": "round", fill: "none" }),
    make("circle", { cx: 9, cy: 9, r: 1.05, fill: color }),
  ];

  const lambda = () => [
    make("rect", { x: 1.6, y: 1.6, width: 14.8, height: 14.8, rx: 3.2, fill: "rgba(3,105,161,0.12)", stroke: "#0369A1", "stroke-width": "1.2" }),
    make("path", { d: "M5.4 4.4h1.4l5.4 9.6M9 8.6 5.6 14", stroke: "#0369A1", "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round", fill: "none" }),
  ];

  const gear = (color) => [
    make("path", { d: "M9 1.8l1.2 1.9 2.2-.6.4 2.2 2.2.6-.6 2.2L16.2 9l-1.8 1.2.6 2.2-2.2.4-.6 2.2-2.2-.6L9 16.2l-1.2-1.8-2.2.6-.4-2.2-2.2-.6.6-2.2L1.8 9l1.8-1.2-.6-2.2 2.2-.4.6-2.2 2.2.6Z", fill: "none", stroke: color, "stroke-width": "1.2", "stroke-linejoin": "round" }),
    make("circle", { cx: 9, cy: 9, r: 2.3, fill: "none", stroke: color, "stroke-width": "1.3" }),
  ];

  const lock = () => [
    make("rect", { x: 3.2, y: 7.6, width: 11.6, height: 8, rx: 1.8, fill: "rgba(140,137,128,0.18)", stroke: "#6C6960", "stroke-width": "1.3" }),
    make("path", { d: "M5.8 7.6V5.6a3.2 3.2 0 0 1 6.4 0v2", stroke: "#6C6960", "stroke-width": "1.3", fill: "none" }),
    make("circle", { cx: 9, cy: 11.6, r: 1.1, fill: "#6C6960" }),
  ];

  const key = () => [
    make("circle", { cx: 6, cy: 9, r: 3.4, fill: "none", stroke: "#CA8A04", "stroke-width": "1.5" }),
    make("path", { d: "M9.4 9h6.2M13.4 9v2.6M15.4 9v1.8", stroke: "#CA8A04", "stroke-width": "1.5", "stroke-linecap": "round" }),
  ];

  const info = () => [
    make("circle", { cx: 9, cy: 9, r: 7, fill: "rgba(37,99,235,0.12)", stroke: "#2563EB", "stroke-width": "1.3" }),
    make("path", { d: "M9 8v4.6", stroke: "#2563EB", "stroke-width": "1.6", "stroke-linecap": "round" }),
    make("circle", { cx: 9, cy: 5.4, r: 1, fill: "#2563EB" }),
  ];

  const archive = () => [
    ...page("#7C3AED", "rgba(124,58,237,0.10)"),
    make("path", { d: "M7 4v1.2M7 6.4v1.2M7 8.8V10", stroke: "#7C3AED", "stroke-width": "1.3" }),
    make("rect", { x: 5.8, y: 10.6, width: 2.4, height: 2.8, rx: 0.6, fill: "#7C3AED" }),
  ];

  const table = () => [
    make("rect", { x: 2, y: 3, width: 14, height: 12, rx: 1.8, fill: "rgba(22,163,74,0.10)", stroke: "#16A34A", "stroke-width": "1.3" }),
    make("path", { d: "M2 7h14M2 11h14M7 3v12", stroke: "#16A34A", "stroke-width": "1.1" }),
  ];

  const database = () => [
    make("ellipse", { cx: 9, cy: 4.4, rx: 5.6, ry: 2, fill: "none", stroke: "#B45309", "stroke-width": "1.3" }),
    make("path", { d: "M3.4 4.4v9.2c0 1.1 2.5 2 5.6 2s5.6-.9 5.6-2V4.4M3.4 9c0 1.1 2.5 2 5.6 2s5.6-.9 5.6-2", stroke: "#B45309", "stroke-width": "1.3", fill: "none" }),
  ];

  const media = (color, kind) => [
    make("rect", { x: 2, y: 3, width: 14, height: 12, rx: 2, fill: "none", stroke: color, "stroke-width": "1.3" }),
    kind === "audio"
      ? make("path", { d: "M7.4 12.2V6l4.6-1v6.2M7.4 12.2a1.4 1.4 0 1 1-2.8 0 1.4 1.4 0 0 1 2.8 0ZM12 11.2a1.4 1.4 0 1 1-2.8 0 1.4 1.4 0 0 1 2.8 0Z", stroke: color, "stroke-width": "1.15", fill: "none" })
      : make("path", { d: "M7.4 6.4v5.2L11.6 9Z", fill: color }),
  ];

  const lines = (color) => [
    ...page(color, "rgba(108,105,96,0.08)"),
    make("path", { d: "M5.4 8h5.6M5.4 10.4h5.6M5.4 12.8h3.6", stroke: color, "stroke-width": "1.1", "stroke-linecap": "round" }),
  ];

  const angle = (color) => [
    make("path", { d: "M6.6 5 2.8 9l3.8 4M11.4 5l3.8 4-3.8 4", stroke: color, "stroke-width": "1.6", "stroke-linecap": "round", "stroke-linejoin": "round", fill: "none" }),
  ];

  /* ---- format tables ---- */

  const BY_NAME = {
    ".gitignore": git, ".gitattributes": git, ".gitmodules": git, ".gitkeep": git, ".git-blame-ignore-revs": git, ".mailmap": git,
    dockerfile: () => tile("#2496ED", "D"), ".dockerignore": () => tile("#2496ED", "D"),
    "compose.yaml": () => tile("#2496ED", "D"), "compose.yml": () => tile("#2496ED", "D"),
    "docker-compose.yml": () => tile("#2496ED", "D"), "docker-compose.yaml": () => tile("#2496ED", "D"),
    makefile: () => tile("#6D8086", "MK"), gnumakefile: () => tile("#6D8086", "MK"),
    "cmakelists.txt": () => tile("#064F8C", "CM"),
    license: () => pageBadge("#B45309", "§"), "license.md": () => pageBadge("#B45309", "§"), "license.txt": () => pageBadge("#B45309", "§"),
    "readme.md": info, readme: info, "readme.txt": info,
    "package.json": () => tile("#CB3837", "npm"), "package-lock.json": lock, "yarn.lock": lock, "pnpm-lock.yaml": lock,
    "requirements.txt": python, "pyproject.toml": python, "setup.py": python, pipfile: python, "pipfile.lock": lock,
    "poetry.lock": lock, "cargo.lock": lock, "cargo.toml": () => tile("#CE422B", "RS"),
    "lakefile.lean": lambda, "lakefile.toml": lambda, "lean-toolchain": lambda, "lake-manifest.json": lock,
    ".env": key, ".editorconfig": () => gear("#6C6960"), ".bashrc": () => terminal("#2E3440", "#4ADE80"),
    ".zshrc": () => terminal("#2E3440", "#4ADE80"), ".profile": () => terminal("#2E3440", "#4ADE80"),
    ".npmrc": () => tile("#CB3837", "npm"), ".prettierrc": () => gear("#C596C7"), ".eslintrc": () => gear("#4B32C3"),
  };

  const IMAGE = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "tif", "tiff", "heic"];
  const BY_EXT = {
    ipynb: jupyter,
    py: python, pyi: python, pyw: python, pyx: () => hexagon("#3776AB", "Cy"),
    lua: lua, luau: lua,
    sh: () => terminal("#2E3440", "#4ADE80"), bash: () => terminal("#2E3440", "#4ADE80"),
    zsh: () => terminal("#2E3440", "#4ADE80"), fish: () => terminal("#2E3440", "#4ADE80"),
    bat: () => terminal("#1E4A86", "#E5E7EB"), cmd: () => terminal("#1E4A86", "#E5E7EB"),
    ps1: () => terminal("#012456", "#5BC0F8"), psm1: () => terminal("#012456", "#5BC0F8"),
    c: () => cfamily("#5C6BC0", "C", false),
    h: () => cfamily("#8E5EC9", "H", false),
    cpp: () => cfamily("#00599C", "C", true), cc: () => cfamily("#00599C", "C", true), cxx: () => cfamily("#00599C", "C", true), "c++": () => cfamily("#00599C", "C", true),
    hpp: () => cfamily("#7B3FB8", "H", true), hh: () => cfamily("#7B3FB8", "H", true), hxx: () => cfamily("#7B3FB8", "H", true), inl: () => cfamily("#7B3FB8", "H", true),
    cu: () => hexagon("#76B900", "CU"), cs: () => hexagon("#68217A", "C#"),
    java: () => tile("#E76F00", "J"), class: () => tile("#B07219", "J"), jar: () => tile("#B07219", "JAR"),
    kt: () => tile("#7F52FF", "KT"), kts: () => tile("#7F52FF", "KT"), scala: () => tile("#DC322F", "SC"),
    js: () => tile("#F7DF1E", "JS", "#1A1A1A"), mjs: () => tile("#F7DF1E", "JS", "#1A1A1A"), cjs: () => tile("#F7DF1E", "JS", "#1A1A1A"),
    jsx: () => tile("#20232A", "JSX", "#61DAFB"), ts: () => tile("#3178C6", "TS"), tsx: () => tile("#3178C6", "TSX"),
    rs: () => tile("#CE422B", "RS"), go: () => tile("#00ADD8", "GO"), rb: () => tile("#CC342D", "RB"),
    php: () => tile("#777BB4", "PHP"), swift: () => tile("#F05138", "SW"), dart: () => tile("#0175C2", "DT"),
    r: () => tile("#276DC3", "R"), jl: () => tile("#9558B2", "JL"), hs: () => tile("#5E5086", "HS"),
    ml: () => tile("#EE6A1A", "ML"), ex: () => tile("#6E4A7E", "EX"), exs: () => tile("#6E4A7E", "EX"),
    zig: () => tile("#F7A41D", "ZIG", "#1A1A1A"), nim: () => tile("#FFE953", "NIM", "#1A1A1A"),
    vim: () => tile("#019733", "VIM"), pl: () => tile("#39457E", "PL"), asm: () => tile("#6E4C13", "ASM"), s: () => tile("#6E4C13", "ASM"),
    lean: lambda, olean: lambda, agda: () => tile("#3E6F8E", "AG"), v: () => tile("#BE9B66", "V"),
    md: markdown, markdown: markdown, mdx: markdown, rst: () => lines("#5C5A54"), tex: () => tile("#008080", "TeX"), bib: () => tile("#008080", "BIB"),
    json: () => braces("#C49A06"), jsonc: () => braces("#C49A06"), json5: () => braces("#C49A06"),
    yaml: () => pageBadge("#CB171E", "YML"), yml: () => pageBadge("#CB171E", "YML"),
    toml: () => pageBadge("#9C4221", "TML"), ini: () => gear("#6C6960"), cfg: () => gear("#6C6960"), conf: () => gear("#6C6960"),
    env: key, pem: key, key: key, crt: key, pub: key,
    xml: () => angle("#E37933"), html: () => angle("#E34F26"), htm: () => angle("#E34F26"), vue: () => tile("#41B883", "VUE"),
    svelte: () => tile("#FF3E00", "SV"), css: () => tile("#1572B6", "#"), scss: () => tile("#CF649A", "#"), less: () => tile("#1D365D", "#"),
    svg: () => angle("#FFB13B"),
    pdf: pdf,
    csv: table, tsv: table, xlsx: table, xls: table, parquet: table,
    sql: database, db: database, sqlite: database, sqlite3: database,
    zip: archive, gz: archive, tgz: archive, tar: archive, bz2: archive, xz: archive, "7z": archive, rar: archive, zst: archive,
    mp3: () => media("#DB2777", "audio"), wav: () => media("#DB2777", "audio"), ogg: () => media("#DB2777", "audio"), flac: () => media("#DB2777", "audio"), m4a: () => media("#DB2777", "audio"),
    mp4: () => media("#7C3AED", "video"), mov: () => media("#7C3AED", "video"), webm: () => media("#7C3AED", "video"), mkv: () => media("#7C3AED", "video"), avi: () => media("#7C3AED", "video"),
    txt: () => lines("#6C6960"), log: () => lines("#8C8980"), lock: lock,
    doc: () => tile("#2B579A", "W"), docx: () => tile("#2B579A", "W"), ppt: () => tile("#D24726", "P"), pptx: () => tile("#D24726", "P"),
    exe: () => terminal("#1E4A86", "#E5E7EB"), dll: () => gear("#1E4A86"), so: () => gear("#6C6960"), o: () => gear("#6C6960"), a: () => gear("#6C6960"),
    wasm: () => tile("#654FF0", "WA"), proto: () => pageBadge("#4285F4", "PB"), graphql: () => tile("#E10098", "GQ"),
    diff: () => pageBadge("#16A34A", "±"), patch: () => pageBadge("#16A34A", "±"),
  };
  for (const ext of IMAGE) BY_EXT[ext] = image;

  const FOLDER_COLORS = {
    ".git": ["#F05133", "rgba(240,81,51,0.16)"], ".github": ["#24292F", "rgba(36,41,47,0.14)"],
    node_modules: ["#5FA04E", "rgba(95,160,78,0.16)"], src: ["#2563EB", "rgba(37,99,235,0.14)"],
    tests: ["#16A34A", "rgba(22,163,74,0.14)"], test: ["#16A34A", "rgba(22,163,74,0.14)"],
    docs: ["#0F766E", "rgba(15,118,110,0.14)"], build: ["#6C6960", "rgba(108,105,96,0.14)"],
    dist: ["#6C6960", "rgba(108,105,96,0.14)"], ".venv": ["#3776AB", "rgba(55,118,171,0.14)"],
    venv: ["#3776AB", "rgba(55,118,171,0.14)"], __pycache__: ["#3776AB", "rgba(55,118,171,0.10)"],
    ".vscode": ["#007ACC", "rgba(0,122,204,0.14)"], ".lake": ["#0369A1", "rgba(3,105,161,0.14)"],
    examples: ["#9333EA", "rgba(147,51,234,0.14)"], assets: ["#0D9488", "rgba(13,148,136,0.14)"],
    images: ["#0D9488", "rgba(13,148,136,0.14)"],
  };

  function folder(name) {
    const [stroke, fill] = FOLDER_COLORS[name.toLowerCase()] || ["#B45309", "rgba(217,119,6,0.16)"];
    return [make("path", {
      d: "M2.2 4.8C2.2 4 2.8 3.4 3.6 3.4h3.2l1.4 1.5h6.2c.8 0 1.4.6 1.4 1.4v6.7c0 .8-.6 1.4-1.4 1.4H3.6c-.8 0-1.4-.6-1.4-1.4V4.8Z",
      fill, stroke, "stroke-width": "1.35", "stroke-linejoin": "round",
    })];
  }

  function painter(path) {
    const name = path.split("/").at(-1);
    const lower = name.toLowerCase();
    if (BY_NAME[lower]) return BY_NAME[lower];
    if (lower.startsWith(".env.")) return key;
    if (lower.startsWith("dockerfile.") || lower.endsWith(".dockerfile")) return BY_NAME.dockerfile;
    if (lower.startsWith("readme.")) return info;
    if (lower.startsWith("license")) return BY_NAME.license;
    const dot = lower.lastIndexOf(".");
    if (dot > 0 || (dot === 0 && !BY_NAME[lower])) {
      const ext = lower.slice(dot + 1);
      if (BY_EXT[ext]) return BY_EXT[ext];
      if (dot === 0) return () => gear("#8C8980"); // other dotfiles are configuration
    }
    return () => page("#6C6960", "rgba(108,105,96,0.10)");
  }

  function create(path, type) {
    const span = document.createElement("span");
    span.className = "file-icon-svg";
    span.setAttribute("aria-hidden", "true");
    const svg = make("svg", { viewBox: "0 0 18 18", width: "16", height: "16", fill: "none" });
    const name = path.split("/").at(-1);
    svg.append(...(type === "directory" ? folder(name) : painter(path)()));
    span.append(svg);
    return span;
  }

  const PREVIEW = { image: new Set(IMAGE.filter((ext) => !["tif", "tiff", "heic"].includes(ext)).concat(["svg"])), pdf: new Set(["pdf"]), audio: new Set(["mp3", "wav", "ogg", "m4a", "flac"]), video: new Set(["mp4", "webm", "mov"]) };

  function previewKind(path) {
    const ext = path.split(".").at(-1).toLowerCase();
    for (const [kind, set] of Object.entries(PREVIEW)) if (set.has(ext)) return kind;
    return null;
  }

  const MIME = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
    ico: "image/x-icon", avif: "image/avif", svg: "image/svg+xml", pdf: "application/pdf",
    mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4", flac: "audio/flac",
    mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  };
  const mimeType = (path) => MIME[path.split(".").at(-1).toLowerCase()] || "application/octet-stream";

  window.QNBFileIcons = { create, previewKind, mimeType };
})();
