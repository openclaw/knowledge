import * as fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Check } from "typebox/value";
import { AttachInput, ATTACHMENT_CHUNK_BYTES, type AttachOutput } from "./attachment-contract.js";
import { PublicationFiles } from "./publication-files.js";
import { inspectEvidence } from "./evidence-files.js";
import type { Evidence } from "./model.js";

/** Called under the storage identity/SQLite write fence. Chunks are durable and
 * replayable; publication never exposes a partial file. No original is overwritten. */
export function attachChunk(db: DatabaseSync, root: string, scope: string, input: AttachInput, current: () => void, hook: (stage: string) => void = () => {}): AttachOutput {
  if (!Check(AttachInput, input) || [".", "..", ".git", ".knowledge-history"].includes(input.filename.toLowerCase()) || !input.attribution.trim()) throw Error("Invalid attachment request");
  const bytes = Buffer.from(input.data, "base64");
  if (bytes.toString("base64") !== input.data || bytes.length > ATTACHMENT_CHUNK_BYTES || (!bytes.length && !input.final)) throw Error("Send a nonempty base64 chunk of at most 48 KiB, or a final empty chunk");
  const metadata = JSON.stringify({ filename: input.filename, mediaType: input.mediaType || "application/octet-stream", attribution: input.attribution });
  const hash = createHash("sha256").update(bytes).digest("hex");
  let row = db.prepare("SELECT * FROM attachment_uploads WHERE scope=? AND request=?").get(scope, input.requestId);
  if (!row) {
    if (input.offset !== 0) throw Error("Attachment must start at byte offset 0");
    db.prepare("INSERT INTO attachment_uploads VALUES (?,?,?,0,NULL)").run(scope, input.requestId, metadata);
    row = { metadata, received: 0, receipt: null };
  }
  if (row.metadata !== metadata) throw Error("Attachment request ID belongs to different metadata");
  const prior = db.prepare("SELECT * FROM attachment_chunks WHERE scope=? AND request=? AND offset=?").get(scope, input.requestId, input.offset);
  if (prior) {
    if (prior.hash !== hash || prior.size !== bytes.length || prior.final !== Number(input.final)) throw Error("Attachment chunk differs from its original request");
  } else {
    if (row.receipt || input.offset !== row.received) throw Error("Attachment offset does not match received bytes");
    db.prepare("INSERT INTO attachment_chunks VALUES (?,?,?,?,?,?,?)").run(scope, input.requestId, input.offset, hash, bytes.length, Number(input.final), bytes);
    row.received = input.offset + bytes.length;
    db.prepare("UPDATE attachment_uploads SET received=? WHERE scope=? AND request=?").run(row.received!, scope, input.requestId);
  }
  if (row.receipt) {
    const receipt = JSON.parse(String(row.receipt)) as AttachOutput;
    inspectEvidence(path.join(root, scope), receipt.evidence!);
    return receipt;
  }
  if (!input.final) return { requestId: input.requestId, state: "uploading", receivedBytes: Number(row.received) };
  const files = new PublicationFiles(root), relative = `artifacts/${input.requestId}/${input.filename}`;
  const destination = files.guard(`${scope}/${relative}`, true);
  // Recover a process death between the no-clobber install and staging unlink.
  // Only remove our own staging name when it is demonstrably the same inode.
  for (const name of fs.readdirSync(path.dirname(destination)).filter(n => n.startsWith(".upload-"))) {
    const stageRelative = `${scope}/artifacts/${input.requestId}/${name}/original`;
    try {
      const staged = files.guard(stageRelative), a = fs.lstatSync(staged), b = fs.lstatSync(destination);
      if (a.isFile() && !a.isSymbolicLink() && a.dev === b.dev && a.ino === b.ino && a.nlink === 2) {
        fs.unlinkSync(staged); files.sync(path.dirname(staged)); fs.rmdirSync(path.dirname(staged)); files.sync(path.dirname(destination));
      }
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  // Random exclusive staging names are preserved on interruption; retry rebuilds
  // from journaled chunks without trusting or overwriting a stale staging file.
  const stageDir = fs.mkdtempSync(path.join(path.dirname(destination), ".upload-"));
  const staging = path.join(stageDir, "original"), fd = fs.openSync(staging, "wx", 0o600);
  const digest = createHash("sha256");
  try {
    for (const chunk of db.prepare("SELECT data FROM attachment_chunks WHERE scope=? AND request=? ORDER BY offset").iterate(scope, input.requestId)) {
      current(); const data = chunk.data as Uint8Array; digest.update(data); fs.writeFileSync(fd, data);
    }
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  const evidence: Evidence = { path: relative, sha256: digest.digest("hex"), ...JSON.parse(metadata), size: Number(row.received) };
  current();
  try { fs.linkSync(staging, files.guard(`${scope}/${relative}`)); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  hook("attachment-after-link");
  // Only our staging names are removed. Existing destinations must hash-match.
  fs.unlinkSync(staging); fs.rmdirSync(stageDir); files.sync(path.dirname(destination));
  inspectEvidence(path.join(root, scope), evidence);
  hook("attachment-before-receipt");
  const receipt: AttachOutput = { requestId: input.requestId, state: "complete", receivedBytes: Number(row.received), evidence };
  db.prepare("UPDATE attachment_uploads SET receipt=? WHERE scope=? AND request=?").run(JSON.stringify(receipt), scope, input.requestId);
  // Retain per-chunk digests for identical retries, not a second copy of the file.
  db.prepare("UPDATE attachment_chunks SET data=NULL WHERE scope=? AND request=?").run(scope, input.requestId);
  current(); return receipt;
}
