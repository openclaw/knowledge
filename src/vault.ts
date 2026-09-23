import * as fs from "node:fs";
import path from "node:path";
import { inspectEvidence, withEvidenceFile } from "./evidence-files.js";
import { ATTACHMENT_CHUNK_BYTES } from "./attachment-contract.js";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Check } from "typebox/value";
import { Envelope, type Issue, type LoadedRecord, type Scope } from "./model.js";

import { readText, parseYaml, safeRoot } from "./files.js";
import { bundledOntology, parseOntology, resolveOntology, expandTypes, inferType, type OntologySource } from "./ontology.js";
export const SAMPLE_ROOT = fileURLToPath(new URL("../fixtures/sample-vault/", import.meta.url));
const MAX_FILES = 500;
export const digest = (s: string) => createHash("sha256").update(s).digest("hex");
export function sameScope(a: unknown, b: Scope): boolean {
  if (!a || typeof a !== "object" || !Check(Envelope.properties.scope, a)) return false;
  const scope = a as Scope;
  return scope.visibility === b.visibility && (scope.visibility === "sample" ||
    (b.visibility !== "sample" && scope.agentId === b.agentId &&
      (scope.visibility !== "conversation" || (b.visibility === "conversation" && scope.sessionId === b.sessionId))));
}
const summary = ({ metadata, body, raw, hash, ...rest }: LoadedRecord) => rest;

// Scope is selected by the service from trusted authority, never from operation inputs.
export class SampleVault {
  constructor(private readonly root = SAMPLE_ROOT, private readonly scope: Scope = { visibility: "sample" }, private readonly empty = false, private readonly observe?: (records: LoadedRecord[], scope: Scope) => void) {}
  private read(relative: string) { return readText(this.root, relative); }
  async scan(overlay?: { record: LoadedRecord; artifacts: Record<string, string> }) {
    const issues: Issue[] = [];
    const directory = this.empty ? null : await safeRoot(this.root);
    const records: LoadedRecord[] = [];
    const sources: OntologySource[] = [await bundledOntology(issues)];
    let visited = 0, bytes = 0;
    const add = (file: string, code: string, message: string) => issues.push({ path: file, code, message: message.slice(0, 1000) });
    const read = async (file: string) => { const raw = overlay?.artifacts[file] ?? await this.read(file); bytes += Buffer.byteLength(raw); if (bytes > 8 * 1024 * 1024) throw Error("Vault exceeds 8 MiB scan budget"); return raw; };
    const walk = async (dir = "", depth = 0): Promise<void> => {
      if (depth > 8) throw Error("Vault directory depth exceeds 8");
      for await (const entry of directory!.entries(dir || ".", { maxEntries: MAX_FILES + 1, order: "sorted", symlinks: "reject" })) {
        if (++visited > MAX_FILES) throw Error("Vault exceeds 500 entries");
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
          try {
            const raw = await read(file);
            const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
            if (!match) throw Error("Expected a closed YAML frontmatter block");
            const metadata = parseYaml(match[1]);
            // A moved/mislabeled record cannot acquire the containing partition's authority.
            const candidate = metadata && typeof metadata === "object" ? (metadata as { scope?: unknown }).scope : undefined;
            if (!sameScope(candidate, this.scope)) {
              add(file, "invalid-record", "Record scope is missing, invalid, or does not match this partition. Content withheld.");
              continue;
            }
            if (!Check(Envelope, metadata)) throw Error("Record envelope is invalid");
            records.push({ id: metadata.id, title: metadata.title, kind: metadata.kind, type: metadata.type ?? metadata.label ?? metadata.claim_kind ?? "", path: file, revision: metadata.revision, lifecycle: metadata.lifecycle, valid: true, metadata, body: raw.slice(match[0].length), raw, hash: digest(raw) });
          } catch (e) { add(file, "invalid-record", this.scope.visibility === "sample" ? String((e as Error).message) : "Record is unreadable or malformed; original file preserved."); }
        }
      }
    };
    try { if (!this.empty) await walk(); } catch { throw Error("Vault unavailable or scan limit exceeded; no partial catalog returned."); }
    if (overlay) { const old = records.findIndex(r => r.path === overlay.record.path); if (old >= 0) records.splice(old, 1); records.push(overlay.record); }
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
      for (const reference of m.entities ?? []) resolve(reference, true);
      for (const reference of m.dependencies ?? []) resolve(reference);
      for (const e of m.evidence ?? []) {
        try {
          if (!e.path.startsWith("artifacts/")) throw Error("Evidence must be within artifacts/");
          const content = overlay?.artifacts[e.path];
          if (content !== undefined) {
            if (digest(content) !== e.sha256) throw Error("Evidence hash does not match");
            const lines = content.split(/\r?\n/);
            if (e.start_line === undefined || e.end_line === undefined || e.end_line < e.start_line || e.end_line > lines.length) throw Error("Invalid evidence line range");
            if (e.quote && !lines.slice(e.start_line - 1, e.end_line).join("\n").includes(e.quote)) throw Error("Quote not found at evidence locator");
          } else inspectEvidence(this.root, e);
        } catch { problem("invalid-evidence", "Evidence is missing, unsafe, changed, or its locator/quote does not match: " + e.path); }
      }
    }
    if (bytes > 8 * 1024 * 1024) throw Error("Vault exceeds scan budget; no partial catalog returned.");
    if (!overlay) this.observe?.(records, this.scope);
    records.sort((a,b) => a.path.localeCompare(b.path));
    return { records, ontology, sources, issues, checkedAt: new Date().toISOString() };
  }
  async list(input: { offset?: number; limit?: number; kind?: string; type?: string; query?: string }) {
    const data = await this.scan();
    const query = input.query?.toLowerCase().trim();
    const types = input.type ? expandTypes(data.ontology, input.type) : null;
    const matched = data.records.filter(r => (!input.kind || r.kind === input.kind) && (!types || (r.kind === "page" ? types.has(r.type) : r.type === input.type)) && (!query || [r.id, r.title, ...(r.metadata.aliases ?? [])].some(v => v.toLowerCase().includes(query))));
    const offset = input.offset ?? 0, limit = input.limit ?? 50;
    return { records: matched.slice(offset, offset + limit).map(summary), total: matched.length, offset, nextOffset: offset + limit < matched.length ? offset + limit : null, checkedAt: data.checkedAt };
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
        affectedRecords: data.records.filter(r => r.kind === d.definition.kind && r.type === d.definition.name).map(summary),
      })),
      sources: data.sources.map(s => ({ path: s.path, raw: s.raw, valid: s.valid, name: s.manifest?.name ?? "", version: s.manifest?.version ?? "" })),
      affectedRecords: data.records.filter(r => data.issues.some(i => i.path === r.path && ["ontology-unavailable", "required-field", "field-type", "endpoint-type", "filing"].includes(i.code))).map(summary),
      issues: data.issues.slice(0, 1000), totalIssues: data.issues.length, truncated: data.issues.length > 1000,
    };
  }
  async detail(id: string, evidenceOffset = 0, evidenceLimit = 20) {
    const data = await this.scan(), matches = data.records.filter(r => r.id === id);
    if (matches.length !== 1) return { record: null, issues: [], references: [], evidence: [] };
    const r = matches[0], refs = new Set([...(r.metadata.entities ?? []), ...(r.metadata.dependencies ?? []), ...[r.metadata.from, r.metadata.to].filter((x): x is string => Boolean(x))]);
    const references = data.records.filter(other => refs.has(other.id) || other.metadata.from === id || other.metadata.to === id || other.metadata.entities?.includes(id)).map(summary);
    const evidence = [];
    for (const e of (r.metadata.evidence ?? []).slice(evidenceOffset, evidenceOffset + evidenceLimit)) {
      let excerpt = "", verified = false, excerptTruncated = false;
      try {
        if (!e.path.startsWith("artifacts/")) throw Error("Unsafe evidence");
        const inspected = inspectEvidence(this.root, e, 20000);
        excerpt = inspected.excerpt; excerptTruncated = inspected.excerptTruncated; verified = true;
      } catch { /* The diagnostic is attached to the record; no raw filesystem error escapes. */ }
      evidence.push({ ...e, excerpt: verified ? excerpt : "", verified, excerptTruncated });
    }
    return { record: { ...summary(r), body: r.body, raw: r.raw, hash: r.hash, metadata: JSON.stringify(r.metadata, null, 2) }, issues: data.issues.filter(i => i.path === r.path), references, evidence, evidenceTotal: r.metadata.evidence?.length ?? 0 };
  }
  async attachment(input: { id: string; path: string; sha256: string; offset?: number }) {
    const data = await this.scan(), records = data.records.filter(r => r.id === input.id);
    const evidence = records.length === 1 ? records[0].metadata.evidence?.find(e => e.path === input.path && e.sha256 === input.sha256) : undefined;
    if (!evidence) throw Error("Attachment unavailable in this record and scope");
    const offset = input.offset ?? 0;
    return withEvidenceFile(this.root, evidence.path, (fd, size) => {
      inspectEvidence(this.root, evidence);
      if (offset > size) throw Error("Attachment offset exceeds file size");
      const bytes = Buffer.alloc(Math.min(ATTACHMENT_CHUNK_BYTES, size - offset));
      let used = 0;
      while (used < bytes.length) { const n = fs.readSync(fd, bytes, used, bytes.length - used, offset + used); if (!n) throw Error("Attachment changed"); used += n; }
      return { filename: evidence.filename ?? path.basename(evidence.path), mediaType: evidence.mediaType ?? "application/octet-stream", sha256: evidence.sha256,
        size, offset, data: bytes.toString("base64"), nextOffset: offset + used < size ? offset + used : null };
    });
  }

}
