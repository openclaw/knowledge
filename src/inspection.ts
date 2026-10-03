import { eligible } from "./retrieval.js";
import type { SampleVault } from "./vault.js";
import type { CompactMetadata, RecordInput, RecordOutput, OntologyInput, OntologyOutput } from "./inspection-contract.js";
import type { Envelope, LoadedRecord } from "./model.js";

const summary = ({ body, raw, hash, metadata, ...rest }: LoadedRecord) => rest;
const withoutConfidenceEvidence = <T extends { attributionConfidence?: { level: "high" | "medium" | "low"; basis: string } }>(r: T): T => ({ ...r,
  ...(r.attributionConfidence ? { attributionConfidence: { level: r.attributionConfidence.level, basis: r.attributionConfidence.basis } } : {}) });
const next = (offset: number, count: number, total: number) => offset + count < total ? offset + count : null;

export const RECORD_RESPONSE_BYTES = 24 * 1024;
const compactMetadata = (m: Envelope): CompactMetadata => {
  const keys = ["owner", "due_at", "occurred_at", "source_page", "source_event", "entities", "dependencies", "from", "to", "label", "attribution", "assertion_origin", "claim_kind"] as const;
  return { ...Object.fromEntries(keys.filter(k => m[k] !== undefined).map(k => [k, m[k]])),
    ...(m.identity ? { identity: { status: m.identity.status, context: m.identity.context,
      ...(m.identity.candidates ? { candidates: m.identity.candidates.map(({ id, basis }) => ({ id, basis })) } : {}) } } : {}),
    ...(m.attribution_confidence ? { attribution_confidence: { level: m.attribution_confidence.level, basis: m.attribution_confidence.basis } } : {}) };
};

/** Bound complete JSON, not serialized fragments. Every cut has a continuation or omission marker. */
function boundRecord(result: RecordOutput, input: RecordInput): RecordOutput {
  const size = () => Buffer.byteLength(JSON.stringify(result), "utf8");
  if (size() <= RECORD_RESPONSE_BYTES) return result;
  const omit = (key: "relatedStatements" | "sourceFiles" | "identityEvidence" | "links") => {
    if (result[key] !== undefined) { delete result[key]; (result.omitted ??= []).push(key); }
  };
  // These are supplemental navigation/provenance previews, not the record's paged evidence.
  for (const key of ["relatedStatements", "sourceFiles", "identityEvidence", "links"] as const) {
    if (size() <= RECORD_RESPONSE_BYTES) break;
    omit(key);
  }
  for (const key of ["evidence", "references"] as const) {
    const rows = result[key];
    while (rows && rows.length > 1 && size() > RECORD_RESPONSE_BYTES) {
      rows.pop();
      if (key === "evidence") result.nextEvidenceOffset = (input.evidenceOffset ?? 0) + rows.length;
      else result.nextReferenceOffset = (input.referenceOffset ?? 0) + rows.length;
    }
  }
  if (size() > RECORD_RESPONSE_BYTES && result.issues.length > 1) {
    (result.omitted ??= []).push("issues");
    while (result.issues.length > 1 && size() > RECORD_RESPONSE_BYTES) result.issues.pop();
  }
  const r = result.record, key = result.view === "raw" ? "raw" : "body";
  if (r && typeof r[key] === "string" && size() > RECORD_RESPONSE_BYTES) {
    const original = r[key]!; let low = 0, high = original.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2); r[key] = original.slice(0, mid);
      result.content.nextOffset = next(result.content.offset, mid, result.content.totalChars);
      if (size() <= RECORD_RESPONSE_BYTES) low = mid; else high = mid - 1;
    }
    r[key] = original.slice(0, low); result.content.nextOffset = next(result.content.offset, low, result.content.totalChars);
    if (!low && original.length) throw Error("Record details exceed response budget. Use view=raw, metadataView=none and no evidence/references for paged original text.");
  }
  if (size() > RECORD_RESPONSE_BYTES) throw Error("Record metadata or evidence exceeds response budget. Use view=raw, metadataView=none and no evidence/references for paged original text; inspect attachments separately.");
  return result;
}

/** Presentation projections are shared by agents and UI; authority stays in the service. */
export async function inspectRecord(vault: SampleVault, input: RecordInput): Promise<RecordOutput> {
  if (input.metadataView !== undefined && input.includeMetadata !== undefined) throw Error("Use metadataView or legacy includeMetadata, not both.");
  const metadataView = input.metadataView ?? (input.includeMetadata === true ? "full" : input.includeMetadata === false ? "none" : "compact");
  const view = input.view ?? "content", offset = input.offset ?? 0, maxChars = input.maxChars ?? 12000;
  const detail = await vault.detail(input.id, input.evidenceOffset ?? 0, input.evidenceLimit ?? 20), r = detail.record;
  const result: RecordOutput = { view, record: null, content: { offset, totalChars: 0, nextOffset: null }, issues: detail.issues };
  if (!r) return boundRecord(result, input);
  if (input.includeEvidence) result.relatedStatements = detail.relatedStatements ?? [];
  const { body, raw, metadata: serialized, ...base } = r, metadata: Envelope = JSON.parse(serialized);
  const value = view === "content" ? body : view === "raw" ? raw : "";
  const chunk = value.slice(offset, offset + maxChars);
  const refs = detail.references.map(withoutConfidenceEvidence);
  result.record = { ...withoutConfidenceEvidence(base), about: refs.filter(r => metadata.entities?.includes(r.id)).slice(0, 2),
    ...(view === "content" ? { body: chunk } : view === "raw" ? { raw: chunk } : {}),
    ...(metadata.attribution ? { attribution: metadata.attribution } : {}),
    ...(metadata.assertion_origin ? { assertionOrigin: metadata.assertion_origin } : {}),
    ...(metadata.claim_kind ? { claimKind: metadata.claim_kind } : {}),
    ...(refs.find(r => r.id === metadata.owner) ? { owner: refs.find(r => r.id === metadata.owner) } : {}),
    ...(refs.find(r => r.id === metadata.source_page) ? { source: refs.find(r => r.id === metadata.source_page) } : {}),
    ...(metadataView === "full" ? { metadata } : metadataView === "compact" ? { metadata: compactMetadata(metadata) } : {}),
  };
  if (view === "content") { result.links = (detail.links ?? []).slice(0, 1000); result.linksTruncated = (detail.links?.length ?? 0) > 1000; }
  result.content = { offset, totalChars: value.length, nextOffset: next(offset, chunk.length, value.length) };
  if (input.includeReferences) {
    const start = input.referenceOffset ?? 0, limit = input.referenceLimit ?? 20;
    result.references = refs.slice(start, start + limit);
    result.referenceTotal = detail.references.length;
    result.nextReferenceOffset = next(start, result.references.length, detail.references.length);
  }
  if (input.includeEvidence) {
    result.sourceFiles = detail.sourceFiles ?? []; result.sourceFilesTotal = detail.sourceFilesTotal ?? 0;
    result.identityEvidence = detail.identityEvidence ?? [];
    result.evidenceTotal = detail.evidenceTotal ?? 0;
    result.evidenceSourceTotal = detail.evidenceSourceTotal ?? 0;
    result.nextEvidenceOffset = next(input.evidenceOffset ?? 0, detail.evidence.length, result.evidenceTotal);
    let remaining = input.maxEvidenceChars ?? 4000;
    const preview = <T extends { excerpt: string; excerptTruncated: boolean }>(e: T): T => { const excerpt = e.excerpt.slice(0, remaining); remaining -= excerpt.length; return { ...e, excerpt, excerptTruncated: e.excerptTruncated || excerpt.length < e.excerpt.length }; };
    result.identityEvidence = result.identityEvidence.map(candidate => ({ ...candidate, evidence: candidate.evidence.map(preview) }));
    result.sourceFiles = result.sourceFiles.map(file => ({ ...file, evidence: { ...file.evidence, excerpt: "", excerptTruncated: file.evidence.excerpt.length > 0 } }));
    result.evidence = detail.evidence.map(e => {
      const excerpt = e.excerpt.slice(0, remaining); remaining -= excerpt.length;
      return { ...e, excerpt, excerptTruncated: excerpt.length < e.excerpt.length || e.excerptTruncated };
    });
  }
  return boundRecord(result, input);
}

export async function inspectOntology(vault: SampleVault, input: OntologyInput): Promise<OntologyOutput> {
  const view = input.view ?? "catalog", offset = input.offset ?? 0, limit = input.limit ?? (view === "definitions" ? 10 : 50);
  if (input.sourcePath !== undefined && view !== "sources") throw Error("sourcePath requires view=sources.");
  if ((input.name !== undefined || input.kind !== undefined || input.includeRecords) && !["catalog", "definitions"].includes(view)) throw Error("name, kind, and includeRecords apply only to catalog/definitions views.");
  const data = await vault.scan(), o = data.ontology;
  const result: OntologyOutput = { view, available: Boolean(o), name: o?.name ?? "", version: o?.version ?? "", fingerprint: o?.fingerprint ?? "", total: 0, offset, nextOffset: null, totalIssues: data.issues.length };
  const page = <T>(rows: T[]) => { const slice = rows.slice(offset, offset + limit); result.total = rows.length; result.nextOffset = next(offset, slice.length, rows.length); return slice; };
  if (view === "diagnostics") {
    result.issues = page(data.issues);
    result.chain = o?.chain ?? [];
  } else if (view === "sources") {
    if (input.sourcePath !== undefined) {
      // Only already-authorized, enumerated sources may be read; no path access from inputs.
      const source = data.sources.find(s => s.path === input.sourcePath);
      if (!source) throw Error("Ontology source unavailable. List view=sources to find an authorized sourcePath.");
      const raw = source.raw.slice(offset, offset + (input.maxChars ?? 12000));
      result.source = { path: source.path, raw, totalChars: source.raw.length };
      result.total = source.raw.length; result.nextOffset = next(offset, raw.length, source.raw.length);
    } else result.sources = page(data.sources).map(s => ({ path: s.path, valid: s.valid, name: s.manifest?.name ?? "", version: s.manifest?.version ?? "", totalChars: s.raw.length }));
  } else {
    result.definitions = page((o?.definitions ?? []).filter(d => (!input.name || d.definition.name === input.name) && (!input.kind || d.definition.kind === input.kind))).map(d => {
      const def = d.definition;
      const records = eligible(data, undefined, false).filter(r => r.kind === def.kind && r.type === def.name);
      return {
        name: def.name, label: def.label, kind: def.kind, primitive: def.primitive ?? "", description: def.description,
        aliases: def.aliases ?? [], recordCount: records.length,
        ...(view === "definitions" ? { directory: def.directory, fields: def.fields, fromTypes: def.from_types ?? [], toTypes: def.to_types ?? [], pathPrefixes: def.path_prefixes ?? [], ...(def.behaviors ? { behaviors: def.behaviors } : {}), source: d.source, ontology: d.ontology, version: d.version } : {}),
        ...(input.includeRecords ? { records: records.slice(0, 20).map(summary), recordsTruncated: records.length > 20 } : {}),
      };
    });
  }
  return result;
}
