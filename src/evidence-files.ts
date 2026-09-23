import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { PublicationFiles } from "./publication-files.js";
import type { Evidence } from "./model.js";

/** Read originals with bounded memory, no UTF-8 or size assumption. Never follow
 * links or accept a file that changes while it is being read. */
export function withEvidenceFile<T>(root: string, relative: string, read: (fd: number, size: number) => T): T {
  if (!relative.startsWith("artifacts/")) throw Error("Evidence must be within artifacts/");
  const files = new PublicationFiles(root), filename = files.guard(relative);
  const before = fs.lstatSync(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw Error("Unsafe evidence file");
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile() || opened.nlink !== 1) throw Error("Evidence changed");
    const result = read(fd, opened.size);
    const after = fs.lstatSync(files.guard(relative)), end = fs.fstatSync(fd);
    if ([after, end].some(s => s.ino !== opened.ino || s.dev !== opened.dev || s.size !== opened.size || s.mtimeMs !== opened.mtimeMs || s.ctimeMs !== opened.ctimeMs || s.nlink !== 1)) throw Error("Evidence changed while reading");
    return result;
  } finally { fs.closeSync(fd); }
}

export function inspectEvidence(root: string, e: Evidence, previewChars = 0) {
  const ranged = e.start_line !== undefined || e.end_line !== undefined;
  if (ranged && (e.start_line === undefined || e.end_line === undefined || e.end_line < e.start_line)) throw Error("Invalid evidence line range");
  const textual = ranged || /^text\//.test(e.mediaType ?? "") || /(?:json|xml|yaml|javascript)/.test(e.mediaType ?? "") || /\.(txt|md|csv|json|jsonl|ya?ml|log|xml|html|ts|js)$/i.test(e.filename ?? e.path);
  return withEvidenceFile(root, e.path, (fd, size) => {
    const hash = createHash("sha256"), buffer = Buffer.alloc(65536);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let used = 0, line = 1, excerpt = "", excerptChars = 0, tail = "", found = !e.quote, validText = true, pendingCR = "";
    const collect = (s: string) => {
      if (e.start_line !== undefined && (line < e.start_line || line > e.end_line!)) return;
      excerptChars += s.length;
      if (excerpt.length < previewChars) excerpt += s.slice(0, previewChars - excerpt.length);
      if (e.quote && !found) { const part = tail + s; found = part.includes(e.quote); tail = part.slice(-e.quote.length); }
    };
    const text = (value: string, final = false) => {
      value = pendingCR + value; pendingCR = "";
      if (!final && value.endsWith("\r")) { pendingCR = "\r"; value = value.slice(0, -1); }
      const parts = value.replace(/\r\n/g, "\n").split("\n");
      for (let i = 0; i < parts.length; i++) {
        collect(parts[i]);
        if (i < parts.length - 1) { if (e.end_line === undefined || line < e.end_line) collect("\n"); line++; }
      }
    };
    while (used < size) {
      const n = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - used), used);
      if (!n) throw Error("Evidence truncated");
      const chunk = buffer.subarray(0, n); hash.update(chunk); used += n;
      if (textual && validText) { try { text(decoder.decode(chunk, { stream: true })); } catch { validText = false; } }
    }
    if (textual && validText) { try { text(decoder.decode(), true); } catch { validText = false; } }
    const sha256 = hash.digest("hex");
    if (sha256 !== e.sha256 || (e.size !== undefined && e.size !== size)) throw Error("Evidence hash or size does not match");
    if ((ranged && (!validText || e.end_line! > line)) || (e.quote && (!validText || !found))) throw Error("Evidence locator does not match");
    return { size, sha256, excerpt: validText ? excerpt : "", excerptTruncated: validText && excerptChars > excerpt.length };
  });
}
