import { RECORD_MAX_BYTES } from "./limits.js";
import { parseDocument } from "yaml";
import type { LoadedRecord } from "./model.js";
import type { ReconcileEvidenceInput } from "./evidence-reconciliation-contract.js";
import { annotationEvidence } from "./annotations.js";
import { encodeRecordEvidence } from "./source-records.js";

/** Preserve assertion/body/metadata while producing a new representation revision. */
export function prepareEvidenceRevision(previous: LoadedRecord, input: ReconcileEvidenceInput, read: (path: string) => string) {
  if (!previous.valid || previous.hash !== input.expectedHash || previous.revision !== input.expectedRevision) throw Error("Evidence reconciliation conflict: target invalid or changed.");
  if (input.evidence !== undefined && (previous.kind !== "page" || previous.lifecycle !== "active")) throw Error("Current evidence replacement requires an active page.");
  const metadata = { ...previous.metadata, revision: previous.revision + 1, updated_at: new Date().toISOString() };
  // Annotation support remains even when the caller replaces current page associations.
  if (input.evidence !== undefined) metadata.evidence = [...input.evidence, ...annotationEvidence(metadata)];
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(previous.raw)!;
  const doc = parseDocument(match[1]);
  for (const key of ["revision", "updated_at", ...(input.evidence !== undefined ? ["evidence"] : [])]) {
    doc.set(key, doc.createNode((metadata as Record<string, unknown>)[key], { aliasDuplicateObjects: false }));
  }
  doc.set("evidence_change", { reason: input.reason, request_id: input.requestId, at: metadata.updated_at, representation: input.representation });
  const raw = "---\n" + doc.toString() + "---\n" + previous.body;
  const encoded = encodeRecordEvidence({ ...previous, metadata, revision: metadata.revision, raw }, read, input.representation);
  if (Buffer.byteLength(encoded.record.raw) > RECORD_MAX_BYTES) throw Error("Evidence representation exceeds record limits; no change accepted.");
  return encoded;
}
