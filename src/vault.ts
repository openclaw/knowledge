import { temporalPredicate, type TimeFilter } from "./temporal-query.js";
import { withinBudget, compactSummary } from "./response-budget.js";
import { resolveLinks } from "./markdown-links.js";
import { claimCard } from "./claim-card.js";
import { annotationEvidence, annotationProblems } from "./annotations.js";
import { recordSummary as summary, sourceCount } from "./record-summary.js";
import { eligible } from "./retrieval.js";
import { temporalProblems } from "./temporal.js";
import * as fs from "node:fs";
import path from "node:path";
import { EvidenceInspector, fileStamp, inspectEvidence, settledStamp, withEvidenceFile, type VerifiedEvidence } from "./evidence-files.js";
import { ATTACHMENT_DOWNLOAD_CHUNK_BYTES } from "./attachment-contract.js";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Check } from "typebox/value";
import { approvedRecall, Envelope, type Evidence, type Issue, type LoadedRecord, type Scope } from "./model.js";

import { readText, parseYaml, safeRoot } from "./files.js";
import { bundledOntology, parseOntology, resolveOntology, expandTypes, inferType, type OntologySource } from "./ontology.js";
export const SAMPLE_ROOT = fileURLToPath(new URL("../fixtures/sample-vault/", import.meta.url));
/** Runaway guard, not a size budget: a partition this large is a pathological
 * tree (e.g. a misplaced checkout), not ordinary growth. */
export const MAX_ENTRIES = 100_000;
export const digest = (s: string) => createHash("sha256").update(s).digest("hex");
export function sameScope(a: unknown, b: Scope): boolean {
  if (!a || typeof a !== "object" || !Check(Envelope.properties.scope, a)) return false;
  const scope = a as Scope;
  return scope.visibility === b.visibility &&
    (scope.visibility !== "conversation" || (b.visibility === "conversation" && scope.sessionId === b.sessionId));
}

export type ScanResult = { records: LoadedRecord[]; ontology: ReturnType<typeof resolveOntology>; sources: OntologySource[]; issues: Issue[]; checkedAt: string };
/** One record file's parse, valid while the file keeps `stamp`. */
type ParsedFile = { stamp: string; record?: LoadedRecord; issue?: string };
/** Holds one scope's scan state. The owner (RealVault) keeps it across operations.
 * `entry` is the whole last scan, reused only while every file the scan read
 * still has its stamp. `files` and `evidence` are per-file results, so a change
 * reparses and re-verifies only what changed. */
export type ScanCache = { entry?: { tree: string; evidence: Map<string, string>; data: ScanResult }; files?: Map<string, ParsedFile>; evidence?: VerifiedEvidence };
type Overlay = { record?: LoadedRecord; records?: LoadedRecord[]; artifacts: Record<string, string> };

// Scope is selected by the service from trusted authority, never from operation inputs.
export class SampleVault {
  constructor(private readonly root = SAMPLE_ROOT, private readonly scope: Scope = { visibility: "sample" }, private readonly empty = false, private readonly observe?: (records: LoadedRecord[], scope: Scope, evidence: EvidenceInspector) => void, private readonly cache?: ScanCache) {}
  private read(relative: string) { return readText(this.root, relative); }
  /** Current catalog. Reuses the cached scan when no record, ontology or cited
   * file changed; otherwise scans, observes and caches a frozen result. Overlay
   * scans validate unpublished writes and are never cached. */
  async scan(overlay?: Overlay): Promise<ScanResult> {
    if (overlay || !this.cache || this.empty) return (await this.load(overlay)).data;
    // Stamp before reading so a change during the scan forces the next rescan.
    const tree = this.treeStamp(), hit = this.cache.entry;
    if (tree && hit?.tree === tree && [...hit.evidence].every(([file, stamp]) => fileStamp(this.root, file) === stamp)) return hit.data;
    const { data, evidence } = await this.load();
    if (tree) this.cache.entry = { tree, evidence: evidence.stamps, data: freeze(data) };
    else this.cache.entry = undefined;
    return data;
  }
  // Stamp every entry the scan walk visits. Null when the tree exceeds scan
  // limits; the scan itself then reports the failure and nothing is cached.
  private treeStamp(): string | null {
    const entries: string[] = []; let visited = 0;
    const walk = (dir: string, depth: number): boolean => {
      if (depth > 8) return false;
      let names: string[];
      try { names = fs.readdirSync(path.join(this.root, dir)).sort(); } catch { return false; }
      for (const name of names) {
        if (++visited > MAX_ENTRIES) return false;
        const file = dir + name, stamp = fileStamp(this.root, file);
        entries.push(`${file}|${stamp}`);
        if (!dir && (name === "artifacts" || name === ".knowledge-history")) continue;
        if (fs.lstatSync(path.join(this.root, file)).isDirectory() && !walk(file + "/", depth + 1)) return false;
      }
      return true;
    };
    try { return walk("", 0) ? digest(entries.join("\n")) : null; } catch { return null; }
  }
  private async load(overlay?: Overlay): Promise<{ data: ScanResult; evidence: EvidenceInspector }> {
    const issues: Issue[] = [];
    // One read per retained file for this scan; observation reuses the same checks.
    if (this.cache) { this.cache.files ??= new Map(); this.cache.evidence ??= new Map(); }
    const evidence = new EvidenceInspector(this.root, this.cache?.evidence);
    const parsed = this.cache?.files, seen = new Set<string>();
    const directory = this.empty ? null : await safeRoot(this.root);
    const records: LoadedRecord[] = [];
    const sources: OntologySource[] = [await bundledOntology(issues)];
    let visited = 0;
    const add = (file: string, code: string, message: string) => issues.push({ path: file, code, message: message.slice(0, 1000) });
    // Per-file size stays bounded by the guarded reader (64 KiB).
    const read = async (file: string) => overlay?.artifacts[file] ?? await this.read(file);
    const walk = async (dir = "", depth = 0): Promise<void> => {
      if (depth > 8) throw Error("Vault directory depth exceeds 8");
      for await (const entry of directory!.entries(dir || ".", { maxEntries: MAX_ENTRIES + 1, order: "sorted", symlinks: "reject" })) {
        if (++visited > MAX_ENTRIES) throw Error(`Vault exceeds ${MAX_ENTRIES.toLocaleString("en-US")} entries`);
        const file = dir + entry.name;
        if (entry.isSymbolicLink) { add(file, "unsafe-path", "Symbolic links are not read."); if (file === "ontology.yaml") sources.push({ path: file, raw: "", valid: false, manifest: null }); continue; }
        if (file === "ontology.yaml" && !entry.isFile) { sources.push({ path: file, raw: "", valid: false, manifest: null }); add(file, "invalid-ontology", "Active ontology must be a regular file."); continue; }
        if (entry.isDirectory) { if (file !== "artifacts" && file !== ".knowledge-history") await walk(file + "/", depth + 1); continue; }
        if (!entry.isFile) { add(file, "unsafe-path", "Only regular files are read."); continue; }
        if (file === "ontology.yaml" || (file.startsWith("ontologies/") && /\.ya?ml$/.test(file))) {
          let raw = "";
          try { raw = await read(file); sources.push(parseOntology(file, raw, issues)); }
          catch { sources.push({ path: file, raw, valid: false, manifest: null }); add(file, "invalid-ontology", "Ontology file is unreadable or exceeds scan limits."); }
        } else if (file.startsWith("schemas/") && /\.ya?ml$/.test(file)) {
          add(file, "unsupported-schema", "Independent schemas are no longer activated. Move definitions into ontology.yaml.");
        } else if (file.endsWith(".md") && !["README.md", "RESOLVER.md"].includes(entry.name)) {
          // Reuse this file's parse while its stamp is unchanged. The stamp is
          // taken before reading, so a change during the read forces a reparse.
          seen.add(file);
          const stamp = fileStamp(this.root, file), known = parsed?.get(file);
          if (known && known.stamp === stamp && settledStamp(stamp)) {
            if (known.record) records.push({ ...known.record });
            else add(file, "invalid-record", known.issue!);
            continue;
          }
          // Cache only deterministic outcomes of settled files; a failed read is retried.
          const remember = (value: Omit<ParsedFile, "stamp">) => { if (settledStamp(stamp)) parsed?.set(file, { stamp, ...value }); else parsed?.delete(file); };
          let raw: string;
          try { raw = await read(file); }
          catch (e) {
            parsed?.delete(file);
            add(file, "invalid-record", this.scope.visibility === "sample" ? String((e as Error).message) : "Record is unreadable or malformed; original file preserved.");
            continue;
          }
          try {
            const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
            if (!match) throw Error("Expected a closed YAML frontmatter block");
            const metadata = parseYaml(match[1]);
            // A moved/mislabeled record cannot acquire the containing partition's authority.
            const candidate = metadata && typeof metadata === "object" ? (metadata as { scope?: unknown }).scope : undefined;
            if (!sameScope(candidate, this.scope)) {
              const issue = "Record scope is missing, invalid, or does not match this partition. Content withheld.";
              remember({ issue }); add(file, "invalid-record", issue);
              continue;
            }
            if (!Check(Envelope, metadata)) throw Error("Record envelope is invalid");
            const record: LoadedRecord = { id: metadata.id, title: metadata.title, kind: metadata.kind, type: metadata.type ?? metadata.label ?? metadata.claim_kind ?? "", path: file, revision: metadata.revision, lifecycle: metadata.lifecycle, valid: true, metadata: parsed ? freeze(metadata) : metadata, body: raw.slice(match[0].length), raw, hash: digest(raw) };
            // Cache a pristine copy (metadata frozen, shared by later scans):
            // validation and observation adjust only the scan's own copy.
            if (!overlay?.artifacts[file]) remember({ record: { ...record } });
            records.push(record);
          } catch (e) {
            const issue = this.scope.visibility === "sample" ? String((e as Error).message) : "Record is unreadable or malformed; original file preserved.";
            remember({ issue }); add(file, "invalid-record", issue);
          }
        }
      }
    };
    try { if (!this.empty) await walk(); } catch { throw Error("Vault unavailable or scan limit exceeded; no partial catalog returned."); }
    // Forget files and citations that no longer exist, so state tracks the tree.
    if (parsed && !overlay) for (const file of parsed.keys()) if (!seen.has(file)) parsed.delete(file);
    if (overlay) for (const record of overlay.records ?? (overlay.record ? [overlay.record] : [])) { const old = records.findIndex(r => r.path === record.path); if (old >= 0) records.splice(old, 1); records.push(record); }
    const ontology = resolveOntology(sources, issues);
    const active = new Map(ontology?.definitions.map(d => [d.definition.name, d.definition]) ?? []);
    // Infer only absent page types; never rewrite authored metadata or override an explicit type.
    for (const r of records) if (r.kind === "page" && !r.metadata.type) r.type = inferType(ontology, r.path) ?? "";
    const byId = new Map<string, LoadedRecord[]>();
    for (const r of records) byId.set(r.id, [...(byId.get(r.id) ?? []), r]);
    for (const r of records) {
      const m = r.metadata;
      const problem = (code: string, message: string) => { r.valid = false; add(r.path, code, message); };
      if (byId.get(r.id)!.length > 1) problem("duplicate-id", "Duplicate stable ID; exact lookup is unavailable until resolved.");
      for (const key of ["recorded_at", "updated_at"] as const) if (!Number.isFinite(Date.parse(m[key]))) problem("invalid-date", `Invalid ${key}`);
      if (Date.parse(m.updated_at) < Date.parse(m.recorded_at)) problem("invalid-date", "updated_at precedes recorded_at");
      const resolve = (id: string, expectedPage = false) => {
        const candidates = byId.get(id);
        if (!candidates || candidates.length !== 1) { problem("broken-reference", "Reference is missing or ambiguous: " + id); return; }
        if (expectedPage && candidates[0].kind !== "page") { problem("invalid-reference", "Expected a page endpoint: " + id); return; }
        return candidates[0];
      };
      if (m.kind === "claim") {
        if (!m.claim_kind || !m.assertion_origin || !m.attribution || !m.evidence?.length || !r.body.trim()) problem("invalid-claim", "Claims require kind, assertion origin, attribution, evidence, and claim text.");
        if (!r.path.startsWith("claims/")) add(r.path, "filing", "Claims have their primary home in claims/.");
      } else {
        const d = active.get(m.kind === "page" ? r.type : m.label ?? "");
        if (!d || d.kind !== m.kind) problem("ontology-unavailable", "No valid effective definition for this record; typed validation unavailable.");
        else {
          if (!r.path.startsWith(d.directory)) add(r.path, "filing", `Expected primary home: ${d.directory}`);
          for (const field of d.fields) {
            const value = m.fields && Object.hasOwn(m.fields, field.name) ? m.fields[field.name] : undefined;
            if (value === undefined) { if (field.required) problem("required-field", `Missing field: ${field.name}`); continue; }
            const correct = field.type === "string[]" ? Array.isArray(value) && value.every(x => typeof x === "string") : typeof value === field.type;
            if (!correct || (field.values && !field.values.includes(value as string))) problem("field-type", `Invalid field: ${field.name}`);
          }
          if (m.kind === "relationship") {
            const from = m.from ? resolve(m.from, true) : undefined, to = m.to ? resolve(m.to, true) : undefined;
            if (!m.from || !m.to || !m.attribution || !m.evidence?.length) problem("invalid-relationship", "Relationships require endpoints, attribution, and evidence.");
            if ((from && (active.get(from.type)?.kind !== "page" || (d.from_types && !d.from_types.includes(from.type)))) || (to && (active.get(to.type)?.kind !== "page" || (d.to_types && !d.to_types.includes(to.type))))) problem("endpoint-type", "Relationship endpoint types do not match its ontology definition.");
          }
        }
      }
      for (const message of temporalProblems(m)) problem("invalid-temporal", message);
      for (const message of annotationProblems(m, id => byId.get(id) ?? [])) problem("invalid-annotation", message);
      if (m.recall !== undefined && !approvedRecall(m.recall)) add(r.path, "invalid-recall", "Recall metadata is invalid or was not issued by the owner-private recall service. Automatic recall is disabled for this record.");
      if (m.owner) resolve(m.owner, true);
      for (const reference of m.entities ?? []) resolve(reference, true);
      for (const reference of m.dependencies ?? []) resolve(reference);
      for (const e of [...(m.evidence ?? []), ...annotationEvidence(m)]) {
        try {
          if (!e.path.startsWith("artifacts/")) throw Error("Evidence must be within artifacts/");
          const content = overlay?.artifacts[e.path];
          if (content !== undefined) {
            if (digest(content) !== e.sha256) throw Error("Evidence hash does not match");
            const lines = content.split(/\r?\n/);
            if (e.start_line === undefined || e.end_line === undefined || e.end_line < e.start_line || e.end_line > lines.length) throw Error("Invalid evidence line range");
            if (e.quote && !lines.slice(e.start_line - 1, e.end_line).join("\n").includes(e.quote)) throw Error("Quote not found at evidence locator");
          } else evidence.inspect(e);
        } catch { problem("invalid-evidence", "Evidence is missing, unsafe, changed, or its locator/quote does not match: " + e.path); }
      }
    }
    if (!overlay) this.observe?.(records, this.scope, evidence);
    const navigable = eligible({ records, ontology, sources, issues, checkedAt: "" }, undefined, false);
    for (const r of navigable) for (const link of resolveLinks(r, navigable)) if (link.status !== "resolved") add(r.path, `${link.status}-link`, `Document link is ${link.status}: ${link.href}`);
    records.sort((a,b) => a.path.localeCompare(b.path));
    if (this.cache?.evidence && !overlay) for (const key of this.cache.evidence.keys()) if (!evidence.used.has(key)) this.cache.evidence.delete(key);
    return { data: { records, ontology, sources, issues, checkedAt: new Date().toISOString() }, evidence };
  }
  async list(input: TimeFilter & { assertionOrigin?: string; includeCards?: boolean; includeEndpoints?: boolean; offset?: number; limit?: number; kind?: string; type?: string; query?: string; lifecycle?: "active" | "all" }) {
    const data = await this.scan();
    const query = input.query?.toLowerCase().trim();
    const timeMatches = temporalPredicate(input);
    const types = input.type ? expandTypes(data.ontology, input.type) : null;
    const current = eligible(data, undefined, false);
    const facets = { kinds: {} as Record<string, number>, origins: {} as Record<string, number> };
    for (const r of current.filter(r => r.kind === "claim")) { facets.kinds[r.type] = (facets.kinds[r.type] ?? 0) + 1; const origin = r.metadata.assertion_origin ?? "unknown"; facets.origins[origin] = (facets.origins[origin] ?? 0) + 1; }
    const matched = (input.lifecycle === "all" ? data.records : current).filter(r => timeMatches(r) && (!input.kind || r.kind === input.kind) && (!input.assertionOrigin || (r.metadata.assertion_origin ?? "unknown") === input.assertionOrigin) && (!types || (r.kind === "page" ? types.has(r.type) : r.type === input.type)) && (!query || [r.id, r.title, ...(r.kind === "claim" ? [r.body] : []), ...(r.metadata.aliases ?? [])].some(v => v.toLowerCase().includes(query))));
    matched.sort((a, b) => b.metadata.updated_at.localeCompare(a.metadata.updated_at) || a.id.localeCompare(b.id));
    const offset = input.offset ?? 0, limit = input.limit ?? 50;
    type Row = ReturnType<typeof summary> & { card?: ReturnType<typeof claimCard> };
    const envelope = (records: Row[], compactEndpoints = false) => {
      // Resolve only the returned page's endpoints within this authorized scan.
      const endpointIds = new Set(records.filter(r => r.kind === "relationship").flatMap(r => [r.from, r.to]));
      return { facets, records,
        ...(input.includeEndpoints ? { endpoints: current.filter(r => endpointIds.has(r.id)).map(r => compactEndpoints ? compactSummary(summary(r)) : summary(r)) } : {}),
        total: matched.length, offset, nextOffset: offset + records.length < matched.length ? offset + records.length : null, checkedAt: data.checkedAt };
    };
    let result = envelope([]);
    for (const record of matched.slice(offset, offset + limit)) {
      const row: Row = { ...summary(record), ...(input.includeCards && record.kind === "claim" ? { card: claimCard(record, current) } : {}) };
      let candidate = envelope([...result.records, row]);
      if (!withinBudget(candidate)) {
        if (result.records.length) break;
        // Keep oversized records reachable; full prose/provenance stays in detail.
        candidate = envelope([compactSummary(summary(record))], true);
        if (!withinBudget(candidate)) throw Error("Record summary exceeds the response budget; inspect the record by ID.");
      }
      result = candidate;
    }
    return result;
  }
  async inspectOntology() {
    const data = await this.scan(), o = data.ontology;
    return {
      available: Boolean(o), name: o?.name ?? "", version: o?.version ?? "", fingerprint: o?.fingerprint ?? "", chain: o?.chain ?? [],
      definitions: (o?.definitions ?? []).map(d => ({
        name: d.definition.name, label: d.definition.label, kind: d.definition.kind, primitive: d.definition.primitive ?? "",
        description: d.definition.description, fields: d.definition.fields, fromTypes: d.definition.from_types ?? [], toTypes: d.definition.to_types ?? [],
        directory: d.definition.directory, aliases: d.definition.aliases ?? [], source: d.source, ontology: d.ontology, version: d.version,
        effective: JSON.stringify(d.definition, null, 2),
        affectedRecords: eligible(data, undefined, false).filter(r => r.kind === d.definition.kind && r.type === d.definition.name).map(summary),
      })),
      sources: data.sources.map(s => ({ path: s.path, raw: s.raw, valid: s.valid, name: s.manifest?.name ?? "", version: s.manifest?.version ?? "" })),
      affectedRecords: data.records.filter(r => data.issues.some(i => i.path === r.path && ["ontology-unavailable", "required-field", "field-type", "endpoint-type", "filing"].includes(i.code))).map(summary),
      issues: data.issues.slice(0, 1000), totalIssues: data.issues.length, truncated: data.issues.length > 1000,
    };
  }
  async detail(id: string, evidenceOffset = 0, evidenceLimit = 20) {
    const data = await this.scan(), matches = data.records.filter(r => r.id === id);
    if (matches.length !== 1) return { record: null, issues: [], references: [], evidence: [] };
    const r = matches[0], refs = new Set([...(r.metadata.entities ?? []), ...(r.metadata.dependencies ?? []), ...[r.metadata.from, r.metadata.to, r.metadata.owner, r.metadata.source_page, ...(r.metadata.continuity ?? []).map(c => c.id), ...(r.metadata.identity?.candidates ?? []).map(c => c.id)].filter((x): x is string => Boolean(x))]);
    const references = eligible(data, undefined, false).filter(other => refs.has(other.id) || other.metadata.from === id || other.metadata.to === id || other.metadata.entities?.includes(id) || other.metadata.dependencies?.includes(id) || other.metadata.owner === id).map(summary);
    const evidence = [], inspector = new EvidenceInspector(this.root);
    for (const e of (r.metadata.evidence ?? []).slice(evidenceOffset, evidenceOffset + evidenceLimit)) {
      let excerpt = "", verified = false, excerptTruncated = false;
      try {
        if (!e.path.startsWith("artifacts/")) throw Error("Unsafe evidence");
        const inspected = inspector.inspect(e, 20000);
        excerpt = inspected.excerpt; excerptTruncated = inspected.excerptTruncated; verified = true;
      } catch { /* The diagnostic is attached to the record; no raw filesystem error escapes. */ }
      evidence.push({ ...e, excerpt: verified ? excerpt : "", verified, excerptTruncated });
    }
    const current = eligible(data, undefined, false);
    const inspect = (e: Evidence) => { try { if (!e.path.startsWith("artifacts/")) throw Error("Unsafe evidence"); const result = inspector.inspect(e, 4000); return { ...e, ...result, verified: true }; } catch { return { ...e, excerpt: "", excerptTruncated: false, verified: false }; } };
    const identityEvidence = (r.metadata.identity?.candidates ?? []).map(candidate => ({ id: candidate.id, evidence: candidate.evidence.map(inspect) }));
    const files = new Map<string, { evidence: Evidence; citations: Set<string> }>();
    if (r.kind === "page") {
      for (const evidence of r.metadata.evidence ?? []) files.set(`${evidence.path}:${evidence.sha256}`, { evidence, citations: new Set() });
      for (const claim of current.filter(claim => claim.kind === "claim" && claim.metadata.source_page === r.id)) for (const evidence of claim.metadata.evidence ?? []) { const key = `${evidence.path}:${evidence.sha256}`; let file = files.get(key); if (!file) { file = { evidence, citations: new Set() }; files.set(key, file); } file.citations.add(JSON.stringify([evidence.start_line, evidence.end_line, evidence.quote, evidence.attribution])); }
    }
    const sourceFiles = [...files.values()].slice(0, 100).map(file => ({ evidence: inspect(file.evidence), citations: file.citations.size }));
    const relatedStatements = current.flatMap(other => {
      const outgoing = (r.metadata.continuity ?? []).filter(link => link.id === other.id).map(link => ({ link, incoming: false }));
      const incoming = (other.metadata.continuity ?? []).filter(link => link.id === r.id).map(link => ({ link, incoming: true }));
      return [...outgoing, ...incoming].map(({ link, incoming }) => {
        const source = current.find(source => source.id === other.metadata.source_page);
        return { record: summary(other), text: other.body.slice(0, 4000), ...(other.metadata.attribution ? { attribution: other.metadata.attribution } : {}), ...(other.metadata.assertion_origin ? { assertionOrigin: other.metadata.assertion_origin } : {}), relation: link.relation, basis: link.basis, incoming, ...(source ? { source: summary(source) } : {}) };
      });
    }).slice(0, 100);
    return { sourceFiles, sourceFilesTotal: files.size, identityEvidence, relatedStatements, record: { ...summary(r), body: r.body, raw: r.raw, hash: r.hash, metadata: JSON.stringify(r.metadata, null, 2) }, issues: data.issues.filter(i => i.path === r.path), references, links: resolveLinks(r, eligible(data, undefined, false)), evidence, evidenceTotal: r.metadata.evidence?.length ?? 0, evidenceSourceTotal: sourceCount(r.metadata.evidence) };
  }
  async attachment(input: { id: string; path: string; sha256: string; offset?: number }) {
    const data = await this.scan(), records = data.records.filter(r => r.id === input.id);
    const evidence = records.length === 1 ? records[0].metadata.evidence?.find(e => e.path === input.path && e.sha256 === input.sha256) : undefined;
    if (!evidence) throw Error("Attachment unavailable in this record and scope");
    const offset = input.offset ?? 0;
    return withEvidenceFile(this.root, evidence.path, (fd, size) => {
      inspectEvidence(this.root, evidence);
      if (offset > size) throw Error("Attachment offset exceeds file size");
      const bytes = Buffer.alloc(Math.min(ATTACHMENT_DOWNLOAD_CHUNK_BYTES, size - offset));
      let used = 0;
      while (used < bytes.length) { const n = fs.readSync(fd, bytes, used, bytes.length - used, offset + used); if (!n) throw Error("Attachment changed"); used += n; }
      return { filename: evidence.filename ?? path.basename(evidence.path), mediaType: evidence.mediaType ?? "application/octet-stream", sha256: evidence.sha256,
        size, offset, data: bytes.toString("base64"), nextOffset: offset + used < size ? offset + used : null };
    });
  }

}

// Cached scans are shared by later operations; freezing makes any accidental
// mutation by a reader fail loudly instead of leaking into the next request.
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  return value;
}
