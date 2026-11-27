"use strict";

const A = require("@automerge/automerge");
const readline = require("node:readline");

function toB64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

function fromB64(b64) {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

function encodeChanges(changes) {
  return (changes || []).map((c) => toB64(c));
}

function decodeChanges(list) {
  return (Array.isArray(list) ? list : []).map((c) => fromB64(c));
}

function makeDoc(fileId, text) {
  return A.from({ fileId: String(fileId || ""), text: String(text ?? "") });
}

function handleCommand(req) {
  const op = req.op;
  if (op === "init") {
    const doc = makeDoc(req.fileId, req.text || "");
    return {
      docBase64: toB64(A.save(doc)),
      heads: A.getHeads(doc),
      text: doc.text,
    };
  }

  if (op === "update_text") {
    let prev = req.docBase64 ? A.load(fromB64(req.docBase64)) : makeDoc(req.fileId, "");
    const targetText = String(req.text ?? "");
    let next = prev;
    if (prev.text !== targetText) {
      next = A.change(prev, (draft) => {
        A.updateText(draft, ["text"], targetText);
      });
    }
    const changes = A.getChanges(prev, next);
    return {
      docBase64: toB64(A.save(next)),
      changesBase64: encodeChanges(changes),
      heads: A.getHeads(next),
      text: next.text,
    };
  }

  if (op === "apply_changes") {
    const prev = req.docBase64 ? A.load(fromB64(req.docBase64)) : makeDoc(req.fileId, "");
    let next = prev;
    let merged = false;

    const changes = decodeChanges(req.changesBase64);
    if (changes.length > 0) {
      try {
        const [applied] = A.applyChanges(next, changes);
        next = applied;
        merged = true;
      } catch (_err) {
        merged = false;
      }
    }

    if (req.fallbackDocBase64) {
      const incomingHeads = new Set(A.getHeads(next));
      const remote = A.load(fromB64(req.fallbackDocBase64));
      const remoteHeads = A.getHeads(remote);
      const missingRemoteHeads = remoteHeads.some((h) => !incomingHeads.has(h));
      if (!merged || missingRemoteHeads) {
        next = A.merge(next, remote);
        merged = true;
      }
    }

    if (!merged && typeof req.fallbackText === "string" && next.text !== req.fallbackText) {
      next = A.change(next, (draft) => {
        A.updateText(draft, ["text"], req.fallbackText);
      });
    }

    const outChanges = A.getChanges(prev, next);
    return {
      docBase64: toB64(A.save(next)),
      outChangesBase64: encodeChanges(outChanges),
      heads: A.getHeads(next),
      text: next.text,
    };
  }

  throw new Error(`Unknown CRDT op: ${op}`);
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  if (!line.trim()) return;
  let id = null;
  try {
    const req = JSON.parse(line);
    id = req.id ?? null;
    const result = handleCommand(req);
    process.stdout.write(JSON.stringify({ id, ok: true, result }) + "\n");
  } catch (err) {
    process.stdout.write(JSON.stringify({ id, ok: false, error: String(err?.message || err) }) + "\n");
  }
});
