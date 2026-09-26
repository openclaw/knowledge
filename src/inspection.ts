import { eligible } from "./retrieval.js";
import type { SampleVault } from "./vault.js";
import type { RecordInput, RecordOutput, OntologyInput, OntologyOutput } from "./inspection-contract.js";
import type { LoadedRecord } from "./model.js";

const summary = ({ body, raw, hash, metadata, ...rest }: LoadedRecord) => rest;
const next = (offset: number, count: number, total: number) => offset + count < total ? offset + count : null;

/** Presentation projections are shared by agents and UI; authority stays in the service. */
export async function inspectRecord(vault: SampleVault, input: RecordInput): Promise<RecordOutput> {
  const view = input.view ?? "content", offset = input.offset ?? 0, maxChars = input.maxChars ?? 12000;
  const detail = await vault.detail(input.id, input.evidenceOffset ?? 0, input.evidenceLimit ?? 20), r = detail.record;
  const result: RecordOutput = { view, record: null, content: { offset, totalChars: 0, nextOffset: null }, issues: detail.issues };
  if (!r) return result;
  if (view === "content" || input.includeEvidence) result.relatedStatements = detail.relatedStatements ?? [];
  const { body, raw, metadata: serialized, ...base } = r, metadata = JSON.parse(serialized);
  const value = view === "content" ? body : view === "raw" ? raw : "";
  const chunk = value.slice(offset, offset + maxChars);
  result.record = { ...base, about: detail.references.filter(r => metadata.entities?.includes(r.id)).slice(0, 2),
    ...(view === "content" ? { body: chunk } : view === "raw" ? { raw: chunk } : {}),
    ...(metadata.attribution ? { attribution: metadata.attribution } : {}),
    ...(metadata.assertion_origin ? { assertionOrigin: metadata.assertion_origin } : {}),
    ...(metadata.claim_kind ? { claimKind: metadata.claim_kind } : {}),
    ...(detail.references.find(r => r.id === metadata.owner) ? { owner: detail.references.find(r => r.id === metadata.owner) } : {}),
    ...(detail.references.find(r => r.id === metadata.source_page) ? { source: detail.references.find(r => r.id === metadata.source_page) } : {}),
    ...(input.includeMetadata ? { metadata } : {}),
  };
  if (view === "content") { result.links = (detail.links ?? []).slice(0, 1000); result.linksTruncated = (detail.links?.length ?? 0) > 1000; }
  result.content = { offset, totalChars: value.length, nextOffset: next(offset, chunk.length, value.length) };
  if (input.includeReferences) {
    const start = input.referenceOffset ?? 0, limit = input.referenceLimit ?? 20;
    result.references = detail.references.slice(start, start + limit);
    result.referenceTotal = detail.references.length;
    result.nextReferenceOffset = next(start, result.references.length, detail.references.length);
  }
  if (input.includeEvidence ?? view === "content") {
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
  return result;
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
