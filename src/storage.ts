import { connections } from "./connections.js";
import type { ConnectionsInput } from "./connections-contract.js";
import type { Static } from "typebox";
import path from "node:path";
import { attachChunk } from "./attachments.js";
import { AttachInput, ATTACHMENT_CHUNK_BYTES } from "./attachment-contract.js";
import { inspectEvidence } from "./evidence-files.js";
import { keywordSearch, exactLookup, observeWithdrawals, withdrawnIds, eligible } from "./retrieval.js";
import type { SearchInput, LookupInput } from "./retrieval-contract.js";
import { GitHistory, GitUnavailable, type GitBatch, type GitChange } from "./git-history.js";
import type { SampleVault } from "./vault.js";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Check } from "typebox/value";
import { parseDocument, stringify } from "yaml";
import { Manifest, RealVault, type VaultConfig } from "./real-vault.js";
import { SqliteIdentityStore } from "./identity-store.js";
import { PublicationFiles, type FileChange } from "./publication-files.js";
import { SavePage, ClaimInput, RelationshipInput, CorrectInput, WithdrawInput, type WriteInput, type WriteKind, type Receipt } from "./mutation-contract.js";
import { digest } from "./vault.js";
import { Envelope, type LoadedRecord, type Scope } from "./model.js";
import { lifecycleRecord, lifecycleImpact, assertLifecycleTarget, applyLifecycleGuards } from "./lifecycle.js";
import type { VaultAccess } from "./access.js";

const canonical = (x: unknown): string => JSON.stringify(x, (_, v) => v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
export const scopeKey = (scope: Scope) => scope.visibility === "conversation" ? `conversations/${scope.sessionId}` : "private";
const blocked = () => Error("Knowledge publication pending or conflicted; inspect mutation history and retry the original request. No partial catalog returned.");
type Plan = { rootIdentity: string; before: Manifest; after: Manifest; changes: FileChange[]; actor: string; scope: string; record: LoadedRecord; records?: LoadedRecord[] };
type Prepared = { record: LoadedRecord; artifacts: Record<string, string>; previous?: LoadedRecord; data: Awaited<ReturnType<SampleVault["scan"]>>; snapshot: string; additional?: { before: LoadedRecord; after: LoadedRecord }[]; lifecycle?: CorrectInput | WithdrawInput };
type Row = { scope: string; request: string; intent: string; state: Receipt["state"]; plan: string; receipt: string };
export type PublicationHook = (stage: string) => void;

export class KnowledgeStorage {
  private readonly real: RealVault;
  private readonly git: GitHistory;
  constructor(readonly config: VaultConfig, private readonly store = new SqliteIdentityStore(config.statePath), private readonly hook: PublicationHook = () => {}, git?: GitHistory) {
    this.git = git ?? new GitHistory(config.root);
    this.real = new RealVault(config, store, (records, access) => this.observe(records, access));
  }
  async run<T>(access: VaultAccess, operation: (vault: SampleVault) => Promise<T>): Promise<T> {
    access.assertCurrent();
    this.assertReadable();
    return this.real.run(access, operation);
  }
  private retrievalBinding(access: VaultAccess) { return `${this.config.vaultId}:${scopeKey(access.scope)}`; }
  async search(input: SearchInput, access: VaultAccess) {
    return this.run(access, async vault => {
      const data = await vault.scan();
      access.assertCurrent();
      return this.store.withDatabase(db => keywordSearch(db, data, input, this.retrievalBinding(access), this.config.vaultId, withdrawnIds(db, this.retrievalBinding(access))));
    });
  }
  async lookup(input: LookupInput, access: VaultAccess) {
    return this.run(access, async vault => {
      const data = await vault.scan();
      access.assertCurrent();
      return this.store.withDatabase(db => exactLookup(data, input, withdrawnIds(db, this.retrievalBinding(access))));
    });
  }
  async connections(input: Static<typeof ConnectionsInput>, access: VaultAccess) {
    return this.run(access, async vault => {
      const data = await vault.scan();
      access.assertCurrent();
      return this.store.withDatabase(db => connections(data, input, withdrawnIds(db, this.retrievalBinding(access))));
    });
  }
  async initialize(access: VaultAccess) {
    access.assertCurrent();
    if (!await this.store.lookup(`agent:${this.config.agentId}`)) await this.real.run(access, async () => undefined);
  }
  private transaction<T>(run: (db: DatabaseSync) => T): T {
    return this.store.withDatabase(db => {
      db.exec("BEGIN IMMEDIATE");
      try { const result = run(db); db.exec("COMMIT"); return result; }
      catch (e) { db.exec("ROLLBACK"); throw e; }
    });
  }
  private identity(db: DatabaseSync, files: PublicationFiles, allowed?: Manifest, fallback?: string | null) {
    const manifest = JSON.parse(files.read("vault.json") ?? fallback ?? "null");
    const checkpoint = db.prepare("SELECT manifest FROM identities WHERE agent_key=?").get(`agent:${this.config.agentId}`);
    if (!Check(Manifest, manifest) || manifest.vaultId !== this.config.vaultId || manifest.agentId !== this.config.agentId ||
        !checkpoint || (canonical(manifest) !== canonical(JSON.parse(String(checkpoint.manifest))) && canonical(manifest) !== canonical(allowed))) throw Error("Knowledge vault identity mismatch; recovery review required.");
    return manifest;
  }
  assertReadable() {
    this.store.withDatabase(db => { if (db.prepare("SELECT 1 FROM mutations WHERE state!='published' LIMIT 1").get()) throw blocked(); });
  }
  private row(db: DatabaseSync, scope: string, request: string): Row | undefined { return db.prepare("SELECT * FROM mutations WHERE scope=? AND request=?").get(scope, request) as Row | undefined; }
  private checkReplay(row: Row, intent: string) { if (row.intent !== intent) throw Error("Request ID already belongs to a different payload. Use the original payload for retries."); }
  async attach(input: AttachInput, access: VaultAccess) {
    access.assertCurrent();
    if (!this.config.writesEnabled) throw Error("Knowledge writes are disabled.");
    if (input.expectedVaultId && input.expectedVaultId !== this.config.vaultId) throw Error("Connected vault changed; do not upload this file here.");
    await this.initialize(access);
    this.assertReadable();
    return this.transaction(db => {
      this.identity(db, new PublicationFiles(this.config.root));
      return attachChunk(db, this.config.root, scopeKey(access.scope), input, () => access.assertCurrent(), this.hook);
    });
  }
  save(input: SavePage, access: VaultAccess, actor: string) { return this.publish(input, "page", access, actor); }
  createClaim(input: ClaimInput, access: VaultAccess, actor: string) { return this.publish(input, "claim", access, actor); }
  createRelationship(input: RelationshipInput, access: VaultAccess, actor: string) { return this.publish(input, "relationship", access, actor); }
  async correct(input: CorrectInput, access: VaultAccess, actor: string): Promise<Receipt> {
    if (!Check(CorrectInput, input) || !input.reason.trim()) throw Error("Invalid correction input.");
    const { kind, ...replacement } = input.replacement;
    return this.publish({ ...replacement, requestId: input.requestId, expectedVaultId: input.expectedVaultId, expectedOntologyFingerprint: input.expectedOntologyFingerprint } as WriteInput, kind, access, actor, input);
  }
  async withdraw(input: WithdrawInput, access: VaultAccess, actor: string): Promise<Receipt> {
    if (!Check(WithdrawInput, input) || !input.reason.trim()) throw Error("Invalid withdrawal input.");
    access.assertCurrent();
    if (!this.config.writesEnabled) throw Error("Knowledge writes are disabled.");
    if (input.expectedVaultId && input.expectedVaultId !== this.config.vaultId) throw Error("Connected vault changed; no publication accepted.");
    const scope = scopeKey(access.scope), intent = digest(canonical({ operation: "withdraw", input }));
    const prior = this.store.withDatabase(db => this.row(db, scope, input.requestId));
    if (prior) { this.checkReplay(prior, intent); return this.resume(access, input.requestId); }
    this.assertReadable();
    const prepared = await this.real.run(access, async vault => {
      const snapshot = new PublicationFiles(this.config.root).snapshot(scope), data = await vault.scan();
      const previous = assertLifecycleTarget(data.records, input, false);
      const record = lifecycleRecord(previous, "withdrawn", input, actor);
      if (new PublicationFiles(this.config.root).snapshot(scope) !== snapshot) throw Error("Edit conflict: vault changed during validation.");
      return { record, previous, artifacts: {}, data, snapshot, lifecycle: input };
    });
    return this.accept(input.requestId, intent, prepared, access, actor);
  }
  private async publish(payload: WriteInput, kind: WriteKind, access: VaultAccess, actor: string, correction?: CorrectInput): Promise<Receipt> {
    const schema = kind === "page" ? SavePage : kind === "claim" ? ClaimInput : RelationshipInput;
    if (!Check(schema, payload)) throw Error("Invalid structured write input.");
    // Unified preparation only after validating the operation-specific closed contract.
    const input = payload as SavePage & ClaimInput & RelationshipInput;
    access.assertCurrent();
    if (input.expectedVaultId && input.expectedVaultId !== this.config.vaultId) throw Error("Connected vault changed; this draft belongs to a different vault. No publication was accepted.");
    if (!this.config.writesEnabled) throw Error("Knowledge writes are disabled.");
    if (Boolean(input.id) !== Boolean(input.expectedHash && input.expectedRevision) || (!input.id && (input.expectedHash || input.expectedRevision))) throw Error("Create requires no preconditions; edit requires ID, observed revision, and hash.");
    const scope = scopeKey(access.scope), intent = digest(canonical(correction ? { operation: "correct", input: correction } : kind === "page" ? input : { operation: kind, input }));
    const prior = this.store.withDatabase(db => this.row(db, scope, input.requestId));
    if (prior) { this.checkReplay(prior, intent); return this.resume(access, input.requestId); }
    this.assertReadable();
    // Old clients may still submit source text. Large values use the same file
    // retention service; the page journal never needs to carry a large original.
    let sourceAttachment: import("./model.js").Evidence | undefined;
    if (input.source && Buffer.byteLength(input.source.text) > 65536) {
      const bytes = Buffer.from(input.source.text);
      for (let offset = 0; offset < bytes.length; offset += ATTACHMENT_CHUNK_BYTES) {
        const chunk = bytes.subarray(offset, offset + ATTACHMENT_CHUNK_BYTES);
        const receipt = await this.attach({ requestId: input.requestId, filename: "source.txt", mediaType: "text/plain", attribution: input.source.attribution,
          offset, data: chunk.toString("base64"), final: offset + chunk.length === bytes.length }, access);
        sourceAttachment = receipt.evidence;
      }
    }
    const prepared = await this.real.run(access, async vault => {
      const snapshot = new PublicationFiles(this.config.root).snapshot(scope);
      const data = await vault.scan();
      if (input.expectedOntologyFingerprint && input.expectedOntologyFingerprint !== data.ontology?.fingerprint) throw Error("Ontology changed; inspect the current definitions before submitting a new request.");
      const corrected = correction ? assertLifecycleTarget(data.records, correction, true) : undefined;
      if (corrected && corrected.kind !== kind) throw Error("A correction must preserve record kind.");
      const allowed = this.store.withDatabase(db => eligible(data, withdrawnIds(db, this.retrievalBinding(access)), false));
      const references = [...(input.dependencies ?? []), ...(input.entities ?? []), ...[input.from, input.to, input.owner].filter((id): id is string => Boolean(id))];
      const affected = corrected ? new Set([corrected.id, ...lifecycleImpact(data.records, corrected.id).items.map(r => r.id)]) : undefined;
      if (affected && references.some(id => affected.has(id))) throw Error("Replacement cannot depend on its superseded original.");
      if (references.some(id => !allowed.some(r => r.id === id))) throw Error("Reference unavailable or inactive in this scope.");
      if ([...(input.entities ?? []), ...[input.from, input.to, input.owner].filter((id): id is string => Boolean(id))].some(id => !allowed.some(r => r.id === id && r.kind === "page"))) throw Error("Entity, owner and endpoint references must be pages.");
      const matches = data.records.filter(r => r.id === input.id);
      const previous = input.id && matches.length === 1 ? matches[0] : undefined;
      if (input.id && (!previous || previous.lifecycle !== "active" || !previous.valid || previous.kind !== "page" || previous.hash !== input.expectedHash || previous.revision !== input.expectedRevision)) throw Error("Edit conflict: record changed, disappeared, is ambiguous, or is invalid. No files were changed by this request, and this draft was not saved. Retain your proposed text, reread the current record, and reconcile before creating a new request.");
      const type = kind === "claim" ? input.claim_kind : kind === "relationship" ? input.label : input.type ?? previous?.type;
      const definition = data.ontology?.definitions.find(d => d.definition.name === type && d.definition.kind === kind)?.definition;
      if (kind !== "claim" && !definition) throw Error("Choose a valid type from the current ontology.");
      if (previous && type !== previous.type) throw Error("Type changes are not supported by this page editor.");
      const now = new Date().toISOString(), id = previous?.id ?? randomUUID();
      const relative = previous?.path ?? `${kind === "claim" ? "claims/" : definition!.directory}${id}.md`;
      const revision = (previous?.revision ?? 0) + 1;
      const metadata: Envelope = previous ? { ...previous.metadata, title: input.title, revision, updated_at: now } : {
        format: "knowledge-record-v1", id, revision, kind, title: input.title, scope: access.scope,
        ...(kind === "page" ? { type, fields: {} } : {}), recorded_at: now, updated_at: now, lifecycle: "active",
      };
      if (corrected && correction) {
        metadata.supersedes = corrected.id;
        metadata.lifecycle_change = { reason: correction.reason, at: now, actor, request_id: correction.requestId };
      }
      // Legacy approval metadata has no meaning; remove it on the next journaled save.
      delete (metadata as Record<string, unknown>).acceptance;
      const portable = ["aliases", "tags", "dependencies", ...(kind === "page" ? [] : ["attribution", "evidence", "valid_from", "valid_until", "expires_at"]),
        ...(kind === "claim" ? ["claim_kind", "assertion_origin", "entities", "occurred_at", "owner", "due_at"] : kind === "relationship" ? ["from", "to", "label"] : [])];
      for (const key of portable) if ((input as Record<string, unknown>)[key] !== undefined) (metadata as Record<string, unknown>)[key] = (input as Record<string, unknown>)[key];
      if (kind !== "page" && !input.attribution.trim()) throw Error("Attribution must not be blank.");
      if (input.fields !== undefined) metadata.fields = input.fields;
      if (input.attachments?.length) {
        metadata.evidence = [...(metadata.evidence ?? [])];
        for (const attachment of input.attachments) {
          inspectEvidence(path.join(this.config.root, scope), attachment);
          if (!metadata.evidence.some(e => canonical(e) === canonical(attachment))) metadata.evidence.push(attachment);
        }
      }
      const artifacts: Record<string, string> = {};
      if (sourceAttachment) { metadata.evidence = [...(metadata.evidence ?? []), sourceAttachment]; metadata.attribution = input.source!.attribution; }
      if (input.source && !sourceAttachment) {
        const artifact = `artifacts/${input.requestId}.txt`;
        artifacts[artifact] = input.source.text;
        metadata.evidence = [...(metadata.evidence ?? []), { path: artifact, sha256: digest(input.source.text), start_line: 1, end_line: input.source.text.split(/\r?\n/).length }];
        // Attribution travels with the portable page, not only in the receipt.
        metadata.attribution = input.source.attribution;
      }
      let yaml: string;
      if (previous) {
        const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(previous.raw)!;
        const doc = parseDocument(match[1]);
        doc.delete("acceptance");
        for (const key of ["title", "revision", "updated_at", ...portable.filter(key => (input as Record<string, unknown>)[key] !== undefined), ...(input.fields !== undefined ? ["fields"] : []), ...(input.source ? ["evidence", "attribution"] : input.attachments?.length ? ["evidence"] : [])]) doc.set(key, (metadata as Record<string, unknown>)[key]);
        yaml = doc.toString();
      } else yaml = stringify(metadata);
      const raw = `---\n${yaml}---\n${input.body}`;
      if (Buffer.byteLength(raw) > 65536 || !Check(Envelope, metadata)) throw Error("Record exceeds limits or has invalid metadata.");
      const record: LoadedRecord = { id, title: input.title, kind, type: type!, path: relative, revision, lifecycle: metadata.lifecycle, metadata, raw, body: input.body, hash: digest(raw), valid: true };
      const preview = await vault.scan({ record, artifacts });
      if (!record.valid) throw Error("Record validation failed: " + preview.issues.filter(i => i.path === relative).map(i => i.code).join(", "));
      if (new PublicationFiles(this.config.root).snapshot(scope) !== snapshot) throw Error("Edit conflict: vault changed during validation.");
      const additional = corrected && correction ? [{ before: corrected, after: lifecycleRecord(corrected, "superseded", correction, actor, id) }] : undefined;
      return { record, artifacts, previous, data, snapshot, additional, lifecycle: correction };
    });
    return this.accept(input.requestId, intent, prepared, access, actor);
  }
  private accept(requestId: string, intent: string, prepared: Prepared, access: VaultAccess, actor: string): Receipt {
    const scope = scopeKey(access.scope);
    this.hook("before-accept");
    access.assertCurrent();
    this.transaction(db => {
      const rival = this.row(db, scope, requestId);
      if (rival) { this.checkReplay(rival, intent); return; }
      if (db.prepare("SELECT 1 FROM mutations WHERE state!='published' LIMIT 1").get()) throw blocked();
      const files = new PublicationFiles(this.config.root), before = this.identity(db, files);
      if (files.snapshot(scope) !== prepared.snapshot) throw Error("Edit conflict: vault changed during validation.");
      // Fence the exact snapshot used for schema and reference validation.
      for (const r of prepared.data.records) if (files.hash(`${scope}/${r.path}`) !== r.hash) throw Error("Edit conflict: vault changed during validation.");
      for (const source of prepared.data.sources.filter(s => !s.path.startsWith("bundled:"))) {
        if (files.read(`${scope}/${source.path}`) !== source.raw) throw Error("Ontology changed during validation.");
      }
      for (const evidence of prepared.lifecycle && !("replacement" in prepared.lifecycle) ? [] : prepared.record.metadata.evidence ?? []) if (!(evidence.path in prepared.artifacts)) inspectEvidence(path.join(this.config.root, scope), evidence);
      const stillActive = eligible(prepared.data, withdrawnIds(db, this.retrievalBinding(access)), false);
      const m = prepared.record.metadata;
      const references = [...(m.dependencies ?? []), ...(m.entities ?? []), ...[m.from, m.to, m.owner].filter((id): id is string => Boolean(id))];
      if ((!prepared.lifecycle || "replacement" in prepared.lifecycle) && references.some(id => !stillActive.some(r => r.id === id))) throw Error("Reference unavailable or inactive in this scope.");
      const after = { ...before, generation: before.generation + 1, publicationId: randomUUID() };
      const changes: FileChange[] = [];
      const add = (target: string, old: string | null, raw: string) => {
        const n = changes.length;
        changes.push({ path: target, before: old, after: raw, backup: `${scope}/.knowledge-history/${requestId}/${n}.before`, stage: `${scope}/.knowledge-history/${requestId}/${n}.stage` });
      };
      for (const [p, raw] of Object.entries(prepared.artifacts)) add(`${scope}/${p}`, null, raw);
      add(`${scope}/${prepared.record.path}`, prepared.previous?.raw ?? null, prepared.record.raw);
      for (const change of prepared.additional ?? []) add(`${scope}/${change.after.path}`, change.before.raw, change.after.raw);
      add("vault.json", files.read("vault.json"), JSON.stringify(after) + "\n");
      for (const change of changes) if (files.read(change.path) !== change.before) throw Error("Edit conflict: destination changed or already exists.");
      const receipt: Receipt = { requestId: requestId, state: "accepted", id: prepared.record.id, path: prepared.record.path, revision: prepared.record.revision, hash: prepared.record.hash, at: new Date().toISOString(), message: "Accepted for publication; not yet saved.", indexed: false };
      if (prepared.lifecycle) {
        receipt.operation = "replacement" in prepared.lifecycle ? "correct" : "withdraw";
        receipt.targetId = prepared.lifecycle.id;
        if (receipt.operation === "correct") receipt.replacementId = prepared.record.id;
        receipt.reason = prepared.lifecycle.reason;
        receipt.impact = lifecycleImpact(prepared.data.records, prepared.lifecycle.id);
      }
      const plan: Plan = { rootIdentity: files.identity(), before, after, changes, actor, scope, record: prepared.record, records: [prepared.record, ...(prepared.additional ?? []).map(c => c.after)] };
      access.assertCurrent();
      db.prepare("INSERT INTO mutations VALUES (?,?,?,?,?,?)").run(scope, requestId, intent, "accepted", JSON.stringify(plan), JSON.stringify(receipt));
    });
    this.hook("after-accept");
    return this.resume(access, requestId);
  }
  resume(access: VaultAccess, requestId: string): Receipt {
    access.assertCurrent();
    const published = this.transaction(db => {
      const row = this.row(db, scopeKey(access.scope), requestId);
      if (!row) throw Error("Mutation unavailable in this scope.");
      const plan: Plan = JSON.parse(row.plan), receipt: Receipt = JSON.parse(row.receipt);
      const files = new PublicationFiles(this.config.root);
      if (plan.scope !== scopeKey(access.scope)) throw Error("Mutation scope mismatch");
      if (row.state === "accepted") {
        if (files.identity() !== plan.rootIdentity) throw Error("Stale publisher root identity");
        for (const change of plan.changes) files.repairStageLink(change);
      }
      const manifestChange = plan.changes.at(-1)!;
      const fallback = row.state !== "published" && files.read(manifestChange.backup, true) === manifestChange.before ? manifestChange.before : undefined;
      this.identity(db, files, row.state !== "published" ? plan.after : undefined, fallback);
      if (row.state !== "accepted") { access.assertCurrent(); return receipt; }
      const checkpoint = JSON.parse(String(db.prepare("SELECT manifest FROM identities WHERE agent_key=?").get(`agent:${this.config.agentId}`)!.manifest));
      if (canonical(checkpoint) !== canonical(plan.before)) throw Error("Stale publisher identity");
      try {
        for (const change of plan.changes) {
          access.assertCurrent();
          files.publish(change, stage => this.hook(`${stage}:${change.path}`));
        }
        this.hook("before-receipt");
        for (const change of plan.changes) if (files.read(change.path) !== change.after || (change.before !== null && files.read(change.backup) !== change.before)) throw Error("conflict");
        access.assertCurrent();
        db.prepare("UPDATE identities SET manifest=? WHERE agent_key=?").run(JSON.stringify(plan.after), `agent:${this.config.agentId}`);
        receipt.state = "published"; receipt.message = "Published and available to exact reads; keyword indexing is pending until the next search reconciles this scope.";
        const records = plan.records ?? [plan.record];
        observeWithdrawals(db, records, this.retrievalBinding(access));
        for (const record of records) this.recordObservation(db, plan.scope, record, plan.actor);
        this.enqueueGit(db, plan.scope, plan.changes.filter(c => c.path !== "vault.json").map(c => ({ path: c.path, raw: c.after })), plan.actor, this.publicationToken(plan.scope, requestId));
        receipt.git = { state: "pending", message: "Published; local Git checkpoint pending." };
      } catch (e) {
        if ((e as Error).message !== "conflict") throw e;
        receipt.state = "conflict"; receipt.message = "Concurrent filesystem change preserved. Publication is blocked; retained before/after material requires recovery review. No automatic overwrite or rollback.";
      }
      receipt.at = new Date().toISOString();
      db.prepare("UPDATE mutations SET state=?,receipt=? WHERE scope=? AND request=?").run(receipt.state, JSON.stringify(receipt), row.scope, row.request);
      return receipt;
    });
    if (published.state === "published") this.flushGit(access);
    access.assertCurrent();
    return this.store.withDatabase(db => JSON.parse(this.row(db, scopeKey(access.scope), requestId)!.receipt) as Receipt);
  }
  history(access: VaultAccess, input: { offset?: number; limit?: number; id?: string }) {
    access.assertCurrent();
    return this.store.withDatabase(db => {
      // Pending manifests may be either side of the retained publication. Never
      // allow a different vault to inherit operational history at the same path.
      const pending = db.prepare("SELECT plan FROM mutations WHERE state!='published' LIMIT 1").get();
      const files = new PublicationFiles(this.config.root), plan: Plan | undefined = pending ? JSON.parse(String(pending.plan)) : undefined;
      const last = plan?.changes.at(-1);
      const fallback = plan && files.identity() === plan.rootIdentity && last && files.read(last.backup, true) === last.before ? last.before : undefined;
      this.identity(db, files, plan?.after, fallback);
      const scope = scopeKey(access.scope), offset = input.offset ?? 0, limit = input.limit ?? 50;
      const rows = db.prepare("SELECT sequence,id,provenance,at,path,revision,hash FROM history WHERE scope=? AND (? IS NULL OR id=?) ORDER BY sequence DESC LIMIT ? OFFSET ?").all(scope, input.id ?? null, input.id ?? null, limit + 1, offset);
      const mutations = db.prepare("SELECT receipt FROM mutations WHERE scope=? AND (? IS NULL OR json_extract(receipt,'$.id')=? OR json_extract(receipt,'$.targetId')=?) ORDER BY rowid DESC LIMIT ? OFFSET ?").all(scope, input.id ?? null, input.id ?? null, input.id ?? null, limit + 1, offset).map(r => JSON.parse(String(r.receipt)) as Receipt);
      access.assertCurrent();
      return { git: this.gitStatus(db, scope), entries: rows.slice(0, limit) as unknown as { sequence: number; id: string; provenance: string; at: string; path: string; revision: number; hash: string }[], mutations: mutations.slice(0, limit), nextOffset: rows.length > limit || mutations.length > limit ? offset + limit : null };
    });
  }
  revision(access: VaultAccess, sequence: number) {
    this.history(access, { limit: 1 });
    const result = this.store.withDatabase(db => {
      const row = db.prepare("SELECT raw FROM history WHERE scope=? AND sequence=?").get(scopeKey(access.scope), sequence);
      return { raw: row ? String(row.raw) : null };
    });
    access.assertCurrent(); return result;
  }
  mutation(access: VaultAccess, requestId: string) {
    this.history(access, { limit: 1 });
    const result = this.store.withDatabase(db => {
      const row = this.row(db, scopeKey(access.scope), requestId);
      if (!row) return { receipt: null, files: [] };
      const plan: Plan = JSON.parse(row.plan), files = new PublicationFiles(this.config.root);
      return { receipt: JSON.parse(row.receipt) as Receipt, files: plan.changes.filter(c => c.path !== "vault.json").map(c => ({
        path: c.path.slice(plan.scope.length + 1), before: c.before, proposed: c.after,
        displaced: files.read(c.backup, true),
      })) };
    });
    access.assertCurrent(); return result;
  }
  private publicationToken(scope: string, request: string) { return digest(`${this.config.vaultId}:${scope}:${request}`); }
  private enqueueGit(db: DatabaseSync, scope: string, changes: GitChange[], actor: string, token = digest(randomUUID())) {
    if (!changes.length || !this.config.writesEnabled) return;
    const batch: GitBatch = { token, changes, actor, at: new Date().toISOString() };
    db.prepare("INSERT OR IGNORE INTO git_jobs(scope,token,batch,state,message) VALUES (?,?,?,'pending','Local Git checkpoint pending.')").run(scope, token, JSON.stringify(batch));
    for (const c of changes) {
      if (c.raw === null && !c.fileHash) db.prepare("DELETE FROM git_files WHERE scope=? AND path=?").run(scope, c.path);
      else db.prepare("INSERT OR REPLACE INTO git_files VALUES (?,?,?)").run(scope, c.path, c.fileHash ?? digest(c.raw!));
    }
  }
  private gitStatus(db: DatabaseSync, scope: string) {
    const waiting = db.prepare("SELECT state,message FROM git_jobs WHERE scope=? AND state!='committed' ORDER BY sequence LIMIT 1").get(scope);
    const last = db.prepare("SELECT state,message,commit_id FROM git_jobs WHERE scope=? ORDER BY sequence DESC LIMIT 1").get(scope);
    const pending = Number(db.prepare("SELECT count(*) AS n FROM git_jobs WHERE scope=? AND state!='committed'").get(scope)!.n);
    return { state: !this.config.writesEnabled ? "read-only" as const : waiting ? String(waiting.state) as "pending" | "unavailable" : last ? "committed" as const : "idle" as const,
      pending, message: String(waiting?.message ?? last?.message ?? (this.config.writesEnabled ? "Git will be used automatically when content is observed or published." : "Read-only vault; no Git changes.")) };
  }
  private flushGit(access: VaultAccess) {
    if (!this.config.writesEnabled) return;
    access.assertCurrent();
    this.transaction(db => {
      this.identity(db, new PublicationFiles(this.config.root));
      const scope = scopeKey(access.scope);
      // Retain ordered exact snapshots in SQLite. An earlier gap cannot be
      // overtaken by a later checkpoint in the same authorized scope.
      for (const job of db.prepare("SELECT * FROM git_jobs WHERE scope=? AND state!='committed' ORDER BY sequence").all(scope)) {
        access.assertCurrent();
        let result: NonNullable<Receipt["git"]>;
        try {
          const commit = this.git.checkpoint(JSON.parse(String(job.batch)), this.hook);
          result = { state: "committed", commit, message: "Local Git history recorded." };
        } catch (e) {
          result = { state: e instanceof GitUnavailable ? "unavailable" : "pending", message: (e as Error).message.slice(0, 500) };
        }
        db.prepare("UPDATE git_jobs SET state=?,commit_id=?,message=? WHERE sequence=?").run(result.state, result.commit ?? null, result.message, job.sequence!);
        for (const row of db.prepare("SELECT request,receipt FROM mutations WHERE scope=? AND state='published'").all(scope)) {
          if (this.publicationToken(scope, String(row.request)) !== job.token) continue;
          const receipt: Receipt = JSON.parse(String(row.receipt)); receipt.git = result;
          db.prepare("UPDATE mutations SET receipt=? WHERE scope=? AND request=?").run(JSON.stringify(receipt), scope, row.request!);
        }
        if (result.state !== "committed") break;
      }
    });
  }
  private recordObservation(db: DatabaseSync, scope: string, r: LoadedRecord, provenance: string) {
    db.prepare("INSERT INTO history(scope,id,provenance,at,path,revision,hash,raw) VALUES (?,?,?,?,?,?,?,?)").run(scope, r.id, provenance, new Date().toISOString(), r.path, r.revision, r.hash, r.raw);
    db.prepare("INSERT OR REPLACE INTO observations VALUES (?,?,?,?,?,?)").run(scope, r.id, r.path, r.hash, r.revision, r.raw);
  }
  private observe(records: LoadedRecord[], access: VaultAccess) {
    const scope = access.scope;
    access.assertCurrent();
    this.transaction(db => {
      this.identity(db, new PublicationFiles(this.config.root));
      if (db.prepare("SELECT 1 FROM mutations WHERE state!='published' LIMIT 1").get()) throw blocked();
      const key = scopeKey(scope);
      observeWithdrawals(db, records, this.retrievalBinding(access));
      if (this.config.writesEnabled) {
        const files = new PublicationFiles(this.config.root);
        const snapshot = files.snapshot(key, true);
        const current = new Map<string, string>();
        const originals = new Map<string, string>();
        for (const [relative, hash] of JSON.parse(snapshot) as [string, string][]) {
          if (hash === "directory") continue;
          const raw = files.read(relative);
          if (raw === null || digest(raw) !== hash) throw Error("Vault changed during Git observation.");
          current.set(relative, raw);
        }
        for (const r of records) {
          if (current.get(`${key}/${r.path}`) !== r.raw) throw Error("Vault changed during Git observation.");
          for (const evidence of r.metadata.evidence ?? []) {
            if (!evidence.path.startsWith("artifacts/")) continue;
            const relative = `${key}/${evidence.path}`;
            try {
              const checked = inspectEvidence(path.join(this.config.root, key), evidence);
              // Match gbrain's Git sidecar routing threshold; media/large originals
              // remain in the local vault, outside automatic Git snapshots.
              const media = /^(image|audio|video)\//.test(evidence.mediaType ?? "") || /\.(png|jpe?g|gif|webp|mp[34]|mov|wav|ogg|flac)$/i.test(evidence.filename ?? evidence.path);
              if (!media && checked.size < 100 * 1024 * 1024) originals.set(relative, evidence.sha256);
            } catch { /* Validation already reports unsafe/missing evidence. */ }
          }
        }
        const prior = new Map(db.prepare("SELECT path,hash FROM git_files WHERE scope=?").all(key).map(r => [String(r.path), String(r.hash)]));
        const changes: GitChange[] = [...current].filter(([p, raw]) => prior.get(p) !== digest(raw)).map(([path, raw]) => ({ path, raw }));
        for (const [path, fileHash] of originals) if (prior.get(path) !== fileHash) changes.push({ path, raw: null, fileHash });
        // Artifacts are retained originals; absent references are not deletions.
        for (const p of prior.keys()) if (!current.has(p) && !p.startsWith(`${key}/artifacts/`)) changes.push({ path: p, raw: null });
        if (files.snapshot(key, true) !== snapshot) throw Error("Vault changed during Git observation.");
        this.enqueueGit(db, key, changes, "external observation");
      }
      for (const r of records.filter(r => r.valid && records.filter(other => other.id === r.id).length === 1)) {
        const prior = db.prepare("SELECT * FROM observations WHERE scope=? AND id=?").get(key, r.id);
        if (prior && (prior.hash !== r.hash || prior.path !== r.path)) r.revision = Math.max(r.revision, Number(prior.revision) + 1);
        else if (prior) r.revision = Math.max(r.revision, Number(prior.revision));
        if (!prior || prior.hash !== r.hash || prior.path !== r.path) this.recordObservation(db, key, r, prior ? "external-edit" : "observed");
      }
      for (const prior of db.prepare("SELECT * FROM observations WHERE scope=? AND hash!=''").all(key)) if (!records.some(r => r.id === prior.id)) {
        db.prepare("INSERT INTO history(scope,id,provenance,at,path,revision,hash,raw) VALUES (?,?,?,?,?,?,?,?)").run(key, prior.id!, "external-unavailable", new Date().toISOString(), prior.path!, Number(prior.revision) + 1, "", "");
        db.prepare("UPDATE observations SET hash='',revision=revision+1 WHERE scope=? AND id=?").run(key, prior.id!);
      }
    });
    this.store.withDatabase(db => applyLifecycleGuards(db, records, this.retrievalBinding(access)));
    this.flushGit(access);
  }
}

