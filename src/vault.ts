import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, realpath, lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { Check, Errors } from "typebox/value";
import { Definition, Envelope, type Issue, type LoadedRecord, type SchemaReport } from "./model.js";

export const SAMPLE_ROOT = fileURLToPath(new URL("../fixtures/sample-vault/", import.meta.url));
const MAX_FILE = 64 * 1024;
const MAX_FILES = 500;
export const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const summary = ({ metadata, body, raw, hash, ...rest }: LoadedRecord) => rest;

// Only the bundled synthetic vault is wired to the plugin. No caller-supplied root or path API.
export class SampleVault {
  constructor(private readonly root = SAMPLE_ROOT) {}
  private async read(relative: string): Promise<string> {
    if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some(p => p === ".." || !p)) throw Error("Unsafe path");
    const root = await realpath(this.root);
    let current = root;
    for (const part of relative.split("/")) {
      current = path.join(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw Error("Symbolic links are not read");
    }
    if (!(await realpath(current)).startsWith(root + path.sep)) throw Error("Path outside vault");
    const handle = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_FILE) throw Error("Expected a file no larger than 64 KiB");
      const buffer = Buffer.alloc(MAX_FILE + 1);
      let size = 0;
      while (size < buffer.length) {
        const result = await handle.read(buffer, size, buffer.length - size, null);
        if (!result.bytesRead) break;
        size += result.bytesRead;
      }
      if (size > MAX_FILE) throw Error("File exceeds 64 KiB");
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
    } finally { await handle.close(); }
  }
  async scan() {
    const issues: Issue[] = [];
    const records: LoadedRecord[] = [];
    const schemas: SchemaReport[] = [];
    let visited = 0, bytes = 0;
    const add = (file: string, code: string, message: string) => issues.push({ path: file, code, message: message.slice(0, 1000) });
    const read = async (file: string) => { const raw = await this.read(file); bytes += Buffer.byteLength(raw); if (bytes > 8 * 1024 * 1024) throw Error("Vault exceeds 8 MiB scan budget"); return raw; };
    const yaml = (raw: string): unknown => {
      const doc = parseDocument(raw, { uniqueKeys: true, schema: "core" });
      if (doc.errors.length || doc.warnings.length) throw Error("Invalid YAML: " + [...doc.errors, ...doc.warnings].map(e => e.message).join("; "));
      const value = doc.toJS({ maxAliasCount: 0 });
      // Reject non-JSON values and deep metadata before exposing it through the host.
      const walk = (x: unknown, depth = 0): void => {
        if (depth > 20) throw Error("Metadata nesting exceeds 20 levels");
        if (x === null || typeof x === "string" || typeof x === "boolean") return;
        if (typeof x === "number" && Number.isFinite(x)) return;
        if (Array.isArray(x)) { x.forEach(v => walk(v, depth + 1)); return; }
        if (x && typeof x === "object" && Object.getPrototypeOf(x) === Object.prototype) { Object.values(x).forEach(v => walk(v, depth + 1)); return; }
        throw Error("Metadata must contain finite JSON-compatible values");
      };
      walk(value); return value;
    };
    const walk = async (dir = "", depth = 0): Promise<void> => {
      if (depth > 8) throw Error("Vault directory depth exceeds 8");
      // readdir is intentionally bounded by the small, bundled fixture-only scope.
      for (const entry of (await readdir(path.join(this.root, dir), { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
        if (++visited > MAX_FILES) throw Error("Vault exceeds 500 entries");
        const file = dir + entry.name;
        if (entry.isSymbolicLink()) { add(file, "unsafe-path", "Symbolic links are not read."); continue; }
        if (entry.isDirectory()) { if (file !== "artifacts") await walk(file + "/", depth + 1); continue; }
        if (!entry.isFile()) { add(file, "unsafe-path", "Only regular files are read."); continue; }
        if (file.startsWith("schemas/") && /\.ya?ml$/.test(file)) {
          let raw = "";
          try {
            raw = await read(file);
            const parsed = yaml(raw);
            if (!Check(Definition, parsed)) throw Error(Errors(Definition, parsed).map(e => `${e.instancePath}: ${e.message}`).join("; "));
            if (new Set(parsed.fields.map(f => f.name)).size !== parsed.fields.length) throw Error("Duplicate field names");
            if (parsed.kind === "relationship" && (!parsed.from_types?.length || !parsed.to_types?.length)) throw Error("Relationship requires endpoint types");
            schemas.push({ path: file, raw, valid: true, definition: parsed });
          } catch (e) { schemas.push({ path: file, raw, valid: false, definition: null }); add(file, "invalid-schema", String((e as Error).message)); }
        } else if (file.endsWith(".md") && !["README.md", "RESOLVER.md"].includes(entry.name)) {
          try {
            const raw = await read(file);
            const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
            if (!match) throw Error("Expected a closed YAML frontmatter block");
            const metadata = yaml(match[1]);
            if (!Check(Envelope, metadata)) throw Error(Errors(Envelope, metadata).map(e => `${e.instancePath}: ${e.message}`).join("; "));
            records.push({ id: metadata.id, title: metadata.title, kind: metadata.kind, type: metadata.type ?? metadata.label ?? metadata.claim_kind ?? "", path: file, revision: metadata.revision, acceptance: metadata.acceptance, lifecycle: metadata.lifecycle, valid: true, metadata, body: raw.slice(match[0].length), raw, hash: digest(raw) });
          } catch (e) { add(file, "invalid-record", String((e as Error).message)); }
        }
      }
    };
    try { await walk(); } catch { throw Error("Sample vault unavailable or scan limit exceeded; no partial catalog returned."); }
    for (const s of schemas) {
      if (!s.valid || !s.definition) continue;
      const d = s.definition;
      if (schemas.filter(other => other.definition?.name === d.name).length > 1) {
        s.valid = false; add(s.path, "duplicate-schema", `Schema name ${d.name} is ambiguous; none activated.`);
      }
    }
    const active = new Map(schemas.filter(s => s.valid && s.definition).map(s => [s.definition!.name, s.definition!]));
    for (const s of schemas) {
      if (!s.valid || !s.definition || s.definition.kind !== "relationship") continue;
      if ([...s.definition.from_types!, ...s.definition.to_types!].some(t => active.get(t)?.kind !== "page")) {
        s.valid = false; active.delete(s.definition.name); add(s.path, "invalid-schema", "Endpoint types must name valid page schemas.");
      }
    }
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
        const d = active.get(m.kind === "page" ? m.type ?? "" : m.label ?? "");
        if (!d || d.kind !== m.kind) problem("schema-unavailable", "No valid effective definition for this record; typed validation unavailable.");
        else {
          if (!r.path.startsWith(d.directory)) add(r.path, "filing", `Expected primary home: ${d.directory}`);
          for (const field of d.fields) {
            const value = m.fields?.[field.name];
            if (value === undefined) { if (field.required) problem("required-field", `Missing field: ${field.name}`); continue; }
            const correct = field.type === "string[]" ? Array.isArray(value) && value.every(x => typeof x === "string") : typeof value === field.type;
            if (!correct || (field.values && !field.values.includes(value as string))) problem("field-type", `Invalid field: ${field.name}`);
          }
          if (m.kind === "relationship") {
            const from = m.from ? resolve(m.from, true) : undefined, to = m.to ? resolve(m.to, true) : undefined;
            if (!m.from || !m.to || !m.attribution || !m.evidence?.length) problem("invalid-relationship", "Relationships require endpoints, attribution, and evidence.");
            if ((from && !d.from_types!.includes(from.type)) || (to && !d.to_types!.includes(to.type))) problem("endpoint-type", "Relationship endpoint types do not match its schema.");
          }
        }
      }
      for (const reference of m.entities ?? []) resolve(reference, true);
      for (const reference of m.dependencies ?? []) resolve(reference);
      for (const e of m.evidence ?? []) {
        try {
          if (!e.path.startsWith("artifacts/")) throw Error("Evidence must be within artifacts/");
          const content = await read(e.path);
          if (digest(content) !== e.sha256) throw Error("Evidence hash does not match");
          const lines = content.split(/\r?\n/);
          if (e.end_line < e.start_line || e.end_line > lines.length) throw Error("Invalid evidence line range");
          if (e.quote && !lines.slice(e.start_line - 1, e.end_line).join("\n").includes(e.quote)) throw Error("Quote not found at evidence locator");
        } catch { problem("invalid-evidence", "Evidence is missing, unsafe, changed, or its locator/quote does not match: " + e.path); }
      }
    }
    if (bytes > 8 * 1024 * 1024) throw Error("Sample vault exceeds scan budget; no partial catalog returned.");
    records.sort((a,b) => a.path.localeCompare(b.path));
    return { records, schemas, issues, checkedAt: new Date().toISOString() };
  }
  async list(input: { offset?: number; limit?: number; kind?: string; type?: string; query?: string }) {
    const data = await this.scan();
    const query = input.query?.toLowerCase().trim();
    const matched = data.records.filter(r => (!input.kind || r.kind === input.kind) && (!input.type || r.type === input.type) && (!query || [r.id, r.title, ...(r.metadata.aliases ?? [])].some(v => v.toLowerCase().includes(query))));
    const offset = input.offset ?? 0, limit = input.limit ?? 50;
    return { records: matched.slice(offset, offset + limit).map(summary), total: matched.length, offset, nextOffset: offset + limit < matched.length ? offset + limit : null, checkedAt: data.checkedAt };
  }
  async detail(id: string) {
    const data = await this.scan(), matches = data.records.filter(r => r.id === id);
    if (matches.length !== 1) return { record: null, issues: [], references: [], evidence: [] };
    const r = matches[0], refs = new Set([...(r.metadata.entities ?? []), ...(r.metadata.dependencies ?? []), ...[r.metadata.from, r.metadata.to].filter((x): x is string => Boolean(x))]);
    const references = data.records.filter(other => refs.has(other.id) || other.metadata.from === id || other.metadata.to === id || other.metadata.entities?.includes(id)).map(summary);
    const evidence = [];
    for (const e of r.metadata.evidence ?? []) {
      let excerpt = "", verified = false;
      try {
        if (!e.path.startsWith("artifacts/")) throw Error("Unsafe evidence");
        const raw = await this.read(e.path), lines = raw.split(/\r?\n/);
        if (digest(raw) === e.sha256 && e.start_line <= e.end_line && e.end_line <= lines.length) { excerpt = lines.slice(e.start_line - 1, e.end_line).join("\n").slice(0, 4000); verified = !e.quote || lines.slice(e.start_line - 1, e.end_line).join("\n").includes(e.quote); }
      } catch { /* The diagnostic is attached to the record; no raw filesystem error escapes. */ }
      evidence.push({ ...e, excerpt, verified });
    }
    return { record: { ...summary(r), body: r.body, raw: r.raw, hash: r.hash, metadata: JSON.stringify(r.metadata, null, 2) }, issues: data.issues.filter(i => i.path === r.path), references, evidence };
  }
}
