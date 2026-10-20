import { EditBodyInput } from "./body-edit-contract.js";
import { editBody } from "./body-edit.js";
import { withinBudget } from "./response-budget.js";
import { textWindow } from "./text-window.js";
import { RECORD_MAX_BYTES } from "./limits.js";
import { ReconcileEvidenceInput, type EvidencePreview } from "./evidence-reconciliation-contract.js";
import { prepareEvidenceRevision } from "./evidence-reconciliation.js";
import { encodeRecordEvidence, readSourceDescriptor, recordSourceDependencies } from "./source-records.js";
import { EvidenceReadInput } from "./evidence-read-contract.js";
import { chronicle } from "./chronicle.js";
import { TimelineInput, DayInput, LastSeenInput, LastSeenOutput, SinceInput } from "./chronicle-contract.js";
import { appendActivity, sessionActivity, returnedRecords, type ActivityOrigin, type ActivityInput } from "./session-activity.js";
import { verifyRecords } from "./verification.js";
import { BatchInput, SourceCheckInput, VerifyInput, type SourceIdentity, type VerifyOutput } from "./ingestion-contract.js";
import { recordPath } from "./record-path.js";
import { existsSync } from "node:fs";
import { connections } from "./connections.js";
import { annotationEvidence, annotationProblems } from "./annotations.js";
import { recentActivity, type RecentInput } from "./recent.js";
import type { ConnectionsInput } from "./connections-contract.js";
import type { Static } from "typebox";
import path from "node:path";
import { attachChunk } from "./attachments.js";
import { AttachInput, ATTACHMENT_CHUNK_BYTES } from "./attachment-contract.js";
import { EvidenceInspector, inspectEvidence, settledStamp } from "./evidence-files.js";
import { keywordSearch, verifyKeywordIndex, exactLookup, observeWithdrawals, withdrawnIds, eligible } from "./retrieval.js";
import type { SearchInput, LookupInput } from "./retrieval-contract.js";
import { GitHistory, GitUnavailable, type GitBatch, type GitChange } from "./git-history.js";
import type { SampleVault } from "./vault.js";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Check } from "typebox/value";
import { parseDocument, stringify } from "yaml";
import { parseYaml } from "./files.js";
import { RealVault, type StoreConfig } from "./real-vault.js";
import { Manifest, checkpointKey } from "./store-manifest.js";
import { SqliteIdentityStore } from "./identity-store.js";
import { publicationRole, PublicationFiles, type FileChange } from "./publication-files.js";
import { AnnotateInput, SavePage, ClaimInput, RelationshipInput, CorrectInput, WithdrawInput, RecallInput, type WriteInput, type WriteKind, type Receipt } from "./mutation-contract.js";
import { digest } from "./vault.js";
import { approvedRecall, Envelope, RecordAnnotations, type LoadedRecord, type Recall, type Scope } from "./model.js";
import { lifecycleRecord, lifecycleImpact, assertLifecycleTarget, applyLifecycleGuards } from "./lifecycle.js";
import { mergeRedirects, referenceIds } from "./merge.js";
import { planMerge, planUnmerge, type MergeReport } from "./merge-write.js";
import { MergeInput, UnmergeInput } from "./mutation-contract.js";
import { RememberInput, REMEMBER_EXCERPT_MAX_BYTES, type RememberOutput } from "./remember-contract.js";
import { planRemember, claimPayload } from "./remember.js";
import type { VaultAccess } from "./access.js";

const canonical = (x: unknown): string => JSON.stringify(x, (_, v) => v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
export const scopeKey = (scope: Scope) => scope.visibility === "conversation" ? `conversations/${scope.sessionId}` : "private";
const blocked = () => Error("Knowledge publication pending or conflicted; inspect mutation history and retry the original request. No partial catalog returned.");
// `agentId` is the writing agent, fixed at acceptance so a resumed publication
// keeps its original author whoever resumes it.
type Plan = { descriptors?: Record<string, string>; activity?: ActivityOrigin; rootIdentity: string; before: Manifest; after: Manifest; changes: FileChange[]; actor: string; agentId?: string; scope: string; record: LoadedRecord; records?: LoadedRecord[]; source?: SourceIdentity };
type Prepared = { requiredDescriptors?: Record<string, string>; record: LoadedRecord; artifacts: Record<string, string>; previous?: LoadedRecord; data: Awaited<ReturnType<SampleVault["scan"]>>; snapshot: string; additional?: { before?: LoadedRecord; after: LoadedRecord }[]; batch?: { items: NonNullable<Receipt["items"]>; source?: SourceIdentity; expectedPreviousRequestId?: string }; lifecycle?: CorrectInput | WithdrawInput; merge?: { operation: "merge" | "unmerge"; targetId: string; reason: string; report: MergeReport }; annotation?: boolean; metadataOnly?: boolean; annotationEvidence?: import("./model.js").Evidence[] };
type Row = { scope: string; request: string; intent: string; state: Receipt["state"]; plan: string; receipt: string };
export type PublicationHook = (stage: string) => void;

export class KnowledgeStorage {
  private readonly real: RealVault;
  // Content hash per authored file, valid while its stamp is unchanged, so Git
  // observation re-reads only files that changed since the last scan.
  private readonly observedHashes = new Map<string, { stamp: string; hash: string }>();
  private readonly git: GitHistory;
  constructor(readonly config: StoreConfig, private readonly store = new SqliteIdentityStore(config.statePath), private readonly hook: PublicationHook = () => {}, git?: GitHistory) {
    this.git = git ?? new GitHistory(config.root);
    this.real = new RealVault(config, store, (records, access, evidence) => this.observe(records, access, evidence));
  }
  async run<T>(access: VaultAccess, operation: (vault: SampleVault) => Promise<T>): Promise<T> {
    access.assertCurrent();
    this.assertReadable();
    return this.real.run(access, operation);
  }
  async trackRead<T>(access: VaultAccess, operation: string, read: () => T | Promise<T>): Promise<T> {
    const result = await read();
    if (access.activity && ["search", "lookup", "records", "record", "evidenceRead", "connections", "timeline", "chronicleDay", "chronicleSince", "chronicleLastSeen"].includes(operation)) {
      const records = returnedRecords(result);
      // Best effort: observation must not turn a successful read into a failed read.
      // Authority failures still prevent delivery, even when telemetry fails.
      access.assertCurrent();
      try { this.store.withDatabase(db => appendActivity(db, scopeKey(access.scope), access.agentId, access.activity!, "read", records)); }
      catch { /* This is a session explorer, not a complete security audit log. */ }
    }
    access.assertCurrent();
    return result;
  }
  async sessionActivity(input: ActivityInput, access: VaultAccess) {
    return this.run(access, async vault => {
      const data = await vault.scan();
      access.assertCurrent();
      return this.store.withDatabase(db => sessionActivity(db, scopeKey(access.scope), access.agentId,
        eligible(data, withdrawnIds(db, this.retrievalBinding(access)), false), input));
    });
  }
  private retrievalBinding(access: VaultAccess) { return `${this.config.vaultId}:${scopeKey(access.scope)}`; }
  /** Keep durable withdrawal tombstones authoritative even after external file restoration. */
  async evidenceRead(input: EvidenceReadInput, access: VaultAccess) {
    if (!Check(EvidenceReadInput, input)) throw Error("Invalid evidence passage input.");
    return this.run(access, async vault => {
      await vault.scan();
      const withdrawn = this.store.withDatabase(db => withdrawnIds(db, this.retrievalBinding(access)));
      return vault.evidenceRead(input, withdrawn);
    });
  }
  async search(input: SearchInput, access: VaultAccess) {
    return this.run(access, async vault => {
      const data = await vault.scan();
      access.assertCurrent();
      return this.store.withDatabase(db => keywordSearch(db, data, input, this.retrievalBinding(access), this.config.vaultId, withdrawnIds(db, this.retrievalBinding(access))));
    });
  }
  async verify(input: VerifyInput, access: VaultAccess): Promise<VerifyOutput> {
    if (!Check(VerifyInput, input)) throw Error("Invalid verification input.");
    return this.run(access, async vault => {
      const data = await vault.scan();
      const result = this.store.withDatabase(db => {
        const binding = this.retrievalBinding(access);
        const indexed = verifyKeywordIndex(db, data, binding, this.config.vaultId, withdrawnIds(db, binding));
        return verifyRecords(data, input, indexed);
      });
      access.assertCurrent(); return result;
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
  /** Enumerates approved automatic-recall projections without returning record bodies. */
  async memoryCandidates(input: { kind: "trigger" | "project"; limit: number }, access: VaultAccess) {
    return this.run(access, async vault => {
      const data = await vault.scan();
      const records = this.store.withDatabase(db => eligible(data, withdrawnIds(db, this.retrievalBinding(access)), false))
        .filter(record => record.lifecycle === "active")
        .flatMap(record => {
          const recall = approvedRecall(record.metadata.recall);
          if (!recall || (input.kind === "trigger" ? !recall.triggers?.length : !recall.projects?.length)) return [];
          return [{ id: record.id, title: record.title, path: record.path, revision: record.revision, hash: record.hash, recall }];
        })
        .sort((a, b) => (b.recall.importance ?? 0) - (a.recall.importance ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const result = { records: records.slice(0, input.limit), complete: data.issues.length === 0 && records.length <= input.limit };
      // Bound the worker boundary as well as the final provider projection.
      while (!withinBudget(result) && result.records.length) { result.records.pop(); result.complete = false; }
      access.assertCurrent();
      return result;
    });
  }
  /** Read temporal projections within the same authority and identity fence as search. */
  async timeline(input: Static<typeof TimelineInput>, access: VaultAccess, day?: Static<typeof DayInput>) {
    if (!Check(TimelineInput, input) || (day && !Check(DayInput, day))) throw Error("Invalid temporal query input.");
    return this.run(access, async vault => {
      const data = await vault.scan();
      access.assertCurrent();
      const result = this.store.withDatabase(db => chronicle(db, data, this.retrievalBinding(access), input, withdrawnIds(db, this.retrievalBinding(access)), day));
      access.assertCurrent(); return result;
    });
  }
  /** Day and week queries preserve authored date-only precision. */
  async chronicleDay(input: Static<typeof DayInput>, access: VaultAccess) {
    const { date: _date, timezone: _timezone, week: _week, ...filters } = input;
    return this.timeline({ ...filters, order: "asc" }, access, input);
  }
  /** Occurrence-time range, not a storage-change feed. */
  async chronicleSince(input: SinceInput, access: VaultAccess) {
    if (!Check(SinceInput, input)) throw Error("Invalid since query input.");
    return this.timeline({ ...input, order: "asc" }, access);
  }
  /** Last dated context at a reference instant; never infer contact from absence. */
  async chronicleLastSeen(input: Static<typeof LastSeenInput>, access: VaultAccess): Promise<Static<typeof LastSeenOutput>> {
    if (!Check(LastSeenInput, input)) throw Error("Invalid last-seen input.");
    const cutoff = input.occurredOnOrBefore ?? new Date().toISOString();
    const result = await this.timeline({ entity: input.entity, until: cutoff, eligibility: input.eligibility, includeSources: input.includeSources, order: "desc", limit: 1 }, access);
    return { entity: input.entity, selection: { timeField: "occurred_at", onOrBefore: cutoff, eligibility: input.eligibility ?? "current" }, last: result.items[0] ?? null, snapshot: result.snapshot, freshness: result.freshness, ...(result.sources ? { sources: result.sources } : {}),
      message: "Latest eligible dated context; a mention is not proof of contact. No match does not establish absence of an interaction." };
  }
  async recent(input: Static<typeof RecentInput>, access: VaultAccess) {
    return this.run(access, async vault => {
      const data = await vault.scan();
      access.assertCurrent();
      return this.store.withDatabase(db => {
        const result = recentActivity(db, scopeKey(access.scope), eligible(data, withdrawnIds(db, this.retrievalBinding(access)), false), input, data.records.filter(r => r.metadata.record_class === "fixture").map(r => r.id));
        access.assertCurrent(); return result;
      });
    });
  }
  async initialize(access: VaultAccess) {
    access.assertCurrent();
    if (!await this.store.lookup(checkpointKey(this.config.vaultId))) await this.real.run(access, async () => undefined);
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
    const checkpoint = db.prepare("SELECT manifest FROM identities WHERE agent_key=?").get(checkpointKey(this.config.vaultId));
    if (!Check(Manifest, manifest) || manifest.vaultId !== this.config.vaultId ||
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
  private sourceRow(db: DatabaseSync, scope: string, source: SourceIdentity): Row | undefined {
    return db.prepare("SELECT * FROM mutations WHERE scope=? AND json_extract(plan,'$.source.provider')=? AND json_extract(plan,'$.source.key')=? ORDER BY rowid DESC LIMIT 1").get(scope, source.provider, source.key) as Row | undefined;
  }
  async sourceCheck(input: SourceIdentity, access: VaultAccess) {
    if (!Check(SourceCheckInput, input)) throw Error("Invalid source identity.");
    await this.initialize(access);
    this.history(access, { limit: 1 }); // Same identity and pending-manifest fence as recovery reads.
    const row = this.store.withDatabase(db => this.sourceRow(db, scopeKey(access.scope), input));
    access.assertCurrent();
    return { state: !row ? "missing" as const : JSON.parse(row.plan).source.sha256 === input.sha256 ? "unchanged" as const : "changed" as const,
      receipt: row ? JSON.parse(row.receipt) as Receipt : null,
      message: row ? "Receipt is publication history, not proof outputs remain current. Verify its IDs; never recreate withdrawn or superseded outputs. Changed source bytes require explicit reconciliation." : "No batch source receipt in this scope. Legacy individual writes are not registered; resolve existing records before creating anything." };
  }
  async batch(input: BatchInput, access: VaultAccess, actor: string): Promise<Receipt> {
    if (!Check(BatchInput, input) || Buffer.byteLength(canonical(input)) > 1024 * 1024) throw Error("Invalid batch input or batch exceeds 1 MiB. Use at most 25 records; retain originals with knowledge_attach.");
    access.assertCurrent();
    if (!this.config.writesEnabled || input.expectedVaultId !== this.config.vaultId) throw Error("Writes disabled or connected vault changed; no batch accepted.");
    const scope = scopeKey(access.scope), intent = digest(canonical({ operation: "batch", input }));
    await this.initialize(access);
    const prior = this.store.withDatabase(db => this.row(db, scope, input.requestId));
    if (prior) { this.checkReplay(prior, intent); return this.resume(access, input.requestId); }
    if (input.source) {
      const existing = await this.sourceCheck(input.source, access);
      if (existing.state === "unchanged") return existing.receipt!;
      if (existing.receipt?.requestId !== input.expectedPreviousRequestId) throw Error("Source changed; reconcile the previous receipt and supply its requestId as expectedPreviousRequestId. No batch accepted.");
    } else if (input.expectedPreviousRequestId) throw Error("expectedPreviousRequestId requires source identity.");
    this.assertReadable();
    const keys = new Map<string, string>();
    for (const item of input.items) {
      if (keys.has(item.key)) throw Error("Duplicate batch key.");
      // A page edit targets an existing exact ID, never another local create.
      const id = item.kind === "page" ? item.input.id : undefined;
      if (id?.startsWith("@")) throw Error("Page edit id must be an existing stable ID.");
      keys.set(item.key, id ?? randomUUID());
    }
    if (new Set(keys.values()).size !== keys.size) throw Error("A batch cannot edit the same record twice.");
    const resolve = (value: unknown): unknown => {
      if (typeof value !== "string" || !value.startsWith("@")) return value;
      const id = keys.get(value.slice(1)); if (!id) throw Error("Unknown local batch reference: " + value); return id;
    };
    const prepared = await this.real.run(access, async vault => {
      const snapshot = new PublicationFiles(this.config.root).snapshot(scope), data = await vault.scan();
      const parts: Prepared[] = [];
      for (const item of input.items) {
        const value: Record<string, unknown> = structuredClone(item.input);
        for (const field of ["source_page", "owner", "from", "to"]) if (value[field] !== undefined) value[field] = resolve(value[field]);
        for (const field of ["entities", "dependencies"]) if (Array.isArray(value[field])) value[field] = value[field].map(resolve);
        if (Array.isArray(value.continuity)) value.continuity = value.continuity.map(c => ({ ...c, id: resolve(c.id) }));
        if (value.identity && typeof value.identity === "object") {
          const identity = value.identity as { candidates?: { id: string }[] };
          if (identity.candidates) identity.candidates = identity.candidates.map(c => ({ ...c, id: resolve(c.id) as string }));
        }
        // Explicit template token, opt-in in authored body only; never rewrite retained evidence.
        if (typeof value.body === "string") value.body = value.body.replace(/\[\[@([a-z][a-z0-9_-]{0,39})(\|[^\]\n]+)?\]\]/g, (_, key, label) => `[[${resolve("@" + key)}${label ?? ""}]]`);
        const payload = { ...value, requestId: input.requestId, expectedVaultId: input.expectedVaultId, expectedOntologyFingerprint: input.expectedOntologyFingerprint };
        const schema = item.kind === "page" ? SavePage : item.kind === "claim" ? ClaimInput : RelationshipInput;
        if (!Check(schema, payload)) throw Error("Invalid resolved payload for batch item " + item.key);
        const write = payload as SavePage & ClaimInput & RelationshipInput;
        if (Boolean(write.id) !== Boolean(write.expectedHash && write.expectedRevision) || (!write.id && (write.expectedHash || write.expectedRevision))) throw Error("Page edits require id, expectedHash and expectedRevision; creates omit all three.");
        parts.push(await this.prepare(vault, write, item.kind, access, actor, undefined, undefined, { id: keys.get(item.key)!, data, snapshot }));
      }
      const records = parts.map(p => p.record);
      if (new Set(records.map(r => r.path)).size !== records.length) throw Error("Batch record path collision.");
      const artifacts = Object.assign({}, ...parts.map(p => p.artifacts)) as Record<string, string>;
      const preview = await vault.scan({ records, artifacts });
      const active = this.store.withDatabase(db => eligible(preview, withdrawnIds(db, this.retrievalBinding(access)), false));
      for (const record of records) {
        if (!record.valid) throw Error("Batch validation failed for " + input.items[records.indexOf(record)].key + ": " + preview.issues.filter(i => i.path === record.path).map(i => i.code).join(", "));
        const m = record.metadata, refs = [...(m.dependencies ?? []), ...(m.entities ?? []), ...[m.from, m.to, m.owner].filter((v): v is string => Boolean(v))];
        if (refs.some(id => !active.some(r => r.id === id))) throw Error("Batch reference unavailable or inactive in this scope.");
      }
      if (input.source && !records.some(r => r.metadata.evidence?.some(e => e.sha256 === input.source!.sha256))) throw Error("Source hash must match retained evidence on a batch record.");
      if (new PublicationFiles(this.config.root).snapshot(scope) !== snapshot) throw Error("Edit conflict: vault changed during batch validation.");
      return { ...parts[0], artifacts, requiredDescriptors: Object.assign({}, ...parts.map(p => p.requiredDescriptors ?? {})), additional: parts.slice(1).map(p => ({ before: p.previous, after: p.record })),
        batch: { items: records.map((r, n) => ({ key: input.items[n].key, id: r.id, path: r.path, revision: r.revision, hash: r.hash })), source: input.source, expectedPreviousRequestId: input.expectedPreviousRequestId } };
    });
    return this.accept(input.requestId, intent, prepared, access, actor);
  }
  /**
   * Save 1–20 conversation-derived claims in one call. Subjects resolve by
   * exact ID/title/alias; exact repeats return the saved claim; pages are never
   * created. The excerpt is retained once through the attachment service and
   * every inserted claim cites it; inserts publish as one journaled batch.
   */
  async remember(input: RememberInput, access: VaultAccess, actor: string): Promise<RememberOutput> {
    if (!Check(RememberInput, input) || !input.requestId || Buffer.byteLength(input.excerpt) > REMEMBER_EXCERPT_MAX_BYTES || !input.attribution.trim() || input.items.some(i => !i.text.trim())) throw Error("Invalid remember input: requestId, attribution, an excerpt of at most 16 KiB and 1–20 nonempty items are required.");
    access.assertCurrent();
    if (!this.config.writesEnabled) throw Error("Knowledge writes are disabled.");
    if (input.expectedVaultId && input.expectedVaultId !== this.config.vaultId) throw Error("Connected vault changed; nothing was remembered.");
    await this.initialize(access);
    const requestId = input.requestId, scope = scopeKey(access.scope);
    const { plan, fingerprint } = await this.run(access, async vault => {
      const data = await vault.scan(), withdrawn = this.store.withDatabase(db => withdrawnIds(db, this.retrievalBinding(access)));
      return { plan: planRemember(data, eligible(data, withdrawn, false), input, withdrawn), fingerprint: data.ontology?.fingerprint };
    });
    const prior = this.store.withDatabase(db => this.row(db, scope, requestId));
    const inserts = plan.flatMap((p, n) => p.duplicateOf || p.sameAs !== undefined ? [] : [n]);
    let receipt: Receipt | null = null;
    if (prior) {
      // A replay finds its own published claims as duplicates; keys map them back.
      receipt = await this.resume(access, requestId);
      for (const item of receipt.items ?? []) {
        const n = Number(item.key.slice(1));
        if (!/^i\d+$/.test(item.key) || plan[n]?.duplicateOf !== item.id) throw Error("Request ID already belongs to a different payload. Use the original payload for retries.");
        delete plan[n]!.duplicateOf;
      }
    } else if (inserts.length) {
      if (!fingerprint) throw Error("The ontology is unavailable; nothing was remembered.");
      const upload = await this.attach({ requestId, expectedVaultId: this.config.vaultId, filename: "excerpt.txt", mediaType: "text/plain", attribution: input.attribution,
        offset: 0, data: Buffer.from(input.excerpt).toString("base64"), final: true }, access);
      const evidence = { ...upload.evidence!, start_line: 1, end_line: input.excerpt.split(/\r?\n/).length };
      receipt = await this.batch({ requestId, expectedVaultId: this.config.vaultId, expectedOntologyFingerprint: fingerprint,
        items: inserts.map(n => ({ key: `i${n}`, kind: "claim" as const, input: claimPayload(input.items[n]!, plan[n]!, evidence, input.attribution) })) }, access, actor);
    }
    const inserted = new Map((receipt?.items ?? []).map(i => [Number(i.key.slice(1)), i.id]));
    const items = plan.map((p, n) => {
      const first = p.sameAs ?? n, saved = inserted.get(first);
      const { duplicateOf, sameAs: _sameAs, ...subject } = p;
      return { status: saved && first === n ? "inserted" as const : "duplicate" as const, id: saved ?? duplicateOf ?? plan[first]!.duplicateOf!, ...subject };
    });
    const unlinked = items.filter(i => i.subject === "ambiguous" || i.subject === "missing").length;
    return { items, receipt, message: `${items.filter(i => i.status === "inserted").length} saved, ${items.filter(i => i.status === "duplicate").length} already saved${unlinked ? `, ${unlinked} unlinked because the subject did not match exactly one page` : ""}. A published receipt is a completed save.` };
  }
  /** Publish one bounded page-body change through the normal fenced journal. */
  async editBody(input: EditBodyInput, access: VaultAccess): Promise<Receipt> {
    if (!Check(EditBodyInput, input) || !input.reason.trim() || !withinBudget(input)) throw Error("Invalid or oversized body edit input.");
    access.assertCurrent();
    if (!this.config.writesEnabled) throw Error("Knowledge writes are disabled.");
    if (input.expectedVaultId !== this.config.vaultId) throw Error("Connected vault changed; no publication accepted.");
    await this.initialize(access);
    const scope = scopeKey(access.scope), intent = digest(canonical({ operation: "editBody", input }));
    const prior = this.store.withDatabase(db => this.row(db, scope, input.requestId));
    if (prior) { this.checkReplay(prior, intent); return this.resume(access, input.requestId); }
    this.assertReadable();
    // Assemble inside the authorized store; full body never crosses the tool input.
    const prepared = await this.real.run(access, async vault => {
      const data = await vault.scan(), matches = data.records.filter(r => r.id === input.id);
      const previous = matches.length === 1 ? matches[0] : undefined;
      if (!previous || !previous.valid || previous.kind !== "page" || previous.lifecycle !== "active" ||
        previous.hash !== input.expectedHash || previous.revision !== input.expectedRevision) throw Error("Body edit conflict: target unavailable or changed.");
      const body = editBody(previous.body, input);
      // prepare rechecks the revision and ontology, validates references and final bytes.
      return this.prepare(vault, { requestId: input.requestId, id: input.id, expectedVaultId: input.expectedVaultId,
        expectedRevision: input.expectedRevision, expectedHash: input.expectedHash, expectedOntologyFingerprint: input.expectedOntologyFingerprint,
        title: previous.title, body } as SavePage & ClaimInput & RelationshipInput, "page", access, "agent", undefined, undefined, undefined, input.reason);
    });
    return this.accept(input.requestId, intent, prepared, access, "agent");
  }
  /** Preview or publish one explicit support/representation revision without source deletion. */
  async reconcileEvidence(input: ReconcileEvidenceInput, access: VaultAccess): Promise<EvidencePreview | Receipt> {
    if (!Check(ReconcileEvidenceInput, input) || !input.reason.trim()) throw Error("Invalid evidence reconciliation input.");
    access.assertCurrent();
    if (!this.config.writesEnabled) throw Error("Knowledge writes are disabled.");
    if (input.expectedVaultId !== this.config.vaultId) throw Error("Connected vault changed; no publication accepted.");
    await this.initialize(access);
    const scope = scopeKey(access.scope), intent = digest(canonical({ operation: "reconcileEvidence", input }));
    const prior = this.store.withDatabase(db => this.row(db, scope, input.requestId));
    if (prior) { this.checkReplay(prior, intent); return this.resume(access, input.requestId); }
    this.assertReadable();
    const prepared = await this.real.run(access, async vault => {
      const snapshot = new PublicationFiles(this.config.root).snapshot(scope), data = await vault.scan();
      if (data.ontology?.fingerprint !== input.expectedOntologyFingerprint) throw Error("Ontology changed; inspect before reconciling evidence.");
      const matches = data.records.filter(r => r.id === input.id);
      if (matches.length !== 1) throw Error("Evidence reconciliation target unavailable or ambiguous.");
      const previous = matches[0];
      const encoded = prepareEvidenceRevision(previous, input, p => readSourceDescriptor(path.join(this.config.root, scope), p));
      const preview = await vault.scan({ record: encoded.record, artifacts: encoded.descriptors });
      if (!encoded.record.valid) throw Error("Evidence reconciliation validation failed: " + preview.issues.filter(i => i.path === previous.path).map(i => i.code).join(", "));
      if (new PublicationFiles(this.config.root).snapshot(scope) !== snapshot) throw Error("Edit conflict: vault changed during validation.");
      return { previous, record: encoded.record, data, snapshot, artifacts: encoded.descriptors, requiredDescriptors: encoded.requiredDescriptors, metadataOnly: true,
        annotationEvidence: [...(encoded.record.metadata.evidence ?? []), ...annotationEvidence(encoded.record.metadata)] };
    });
    // Preview does not write descriptors or a mutation row. Apply always revalidates fences.
    access.assertCurrent();
    if (input.dryRun) return { state: "preview", id: input.id, revision: prepared.previous.revision, hash: prepared.previous.hash,
      beforeBytes: Buffer.byteLength(prepared.previous.raw), afterBytes: Buffer.byteLength(prepared.record.raw),
      beforeEvidence: prepared.previous.metadata.evidence?.length ?? 0, afterEvidence: prepared.record.metadata.evidence?.length ?? 0,
      descriptors: Object.keys(prepared.artifacts).length, representation: input.representation };
    return this.accept(input.requestId, intent, prepared, access, input.evidence === undefined ? "conversion" : "agent");
  }
  async annotate(input: AnnotateInput, access: VaultAccess, actor: string): Promise<Receipt> {
    if (!Check(AnnotateInput, input) || !input.reason.trim() || (!Object.keys(input.annotations).length && !input.addEvidence?.length)) throw Error("Invalid annotation input.");
    access.assertCurrent();
    if (!this.config.writesEnabled) throw Error("Knowledge writes are disabled.");
    if (input.expectedVaultId && input.expectedVaultId !== this.config.vaultId) throw Error("Connected vault changed; no publication accepted.");
    await this.initialize(access);
    const scope = scopeKey(access.scope), intent = digest(canonical({ operation: "annotate", input }));
    const prior = this.store.withDatabase(db => this.row(db, scope, input.requestId));
    if (prior) { this.checkReplay(prior, intent); return this.resume(access, input.requestId); }
    this.assertReadable();
    const prepared = await this.real.run(access, async vault => {
      const snapshot = new PublicationFiles(this.config.root).snapshot(scope), data = await vault.scan();
      const matches = data.records.filter(r => r.id === input.id), previous = matches.length === 1 ? matches[0] : undefined;
      if (!previous || previous.hash !== input.expectedHash || previous.revision !== input.expectedRevision) throw Error("Annotation conflict: target unavailable or changed.");
      if (previous.lifecycle !== "active" && (Object.keys(input.annotations).some(k => k !== "record_class") || input.addEvidence?.length)) throw Error("Only fixture classification may annotate historical records.");
      const metadata: Envelope = { ...previous.metadata, ...input.annotations, revision: previous.revision + 1, updated_at: new Date().toISOString() };
      const extra = [...(input.addEvidence ?? []), ...annotationEvidence(metadata)];
      for (const evidence of extra) inspectEvidence(path.join(this.config.root, scope), evidence);
      if (extra.length) metadata.evidence = [...new Map([...(metadata.evidence ?? []), ...extra].map(e => [canonical(e), e])).values()];
      const problems = annotationProblems(metadata, id => data.records.filter(r => r.id === id));
      if (problems.length) throw Error(problems.join("; "));
      const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(previous.raw)!;
      const doc = parseDocument(match[1]);
      for (const key of ["revision", "updated_at", ...Object.keys(input.annotations), ...(extra.length ? ["evidence"] : [])]) doc.set(key, doc.createNode((metadata as Record<string, unknown>)[key], { aliasDuplicateObjects: false }));
      doc.set("annotation_change", { reason: input.reason, actor, request_id: input.requestId, at: metadata.updated_at });
      parseYaml(doc.toString());
      const raw = `---\n${doc.toString()}---\n${previous.body}`;
      const encoded = encodeRecordEvidence({ ...previous, metadata, raw, hash: digest(raw), revision: metadata.revision }, p => readSourceDescriptor(path.join(this.config.root, scope), p));
      const record = encoded.record;
      if (Buffer.byteLength(record.raw) > RECORD_MAX_BYTES) throw Error("Annotation exceeds record limits.");
      if (new PublicationFiles(this.config.root).snapshot(scope) !== snapshot) throw Error("Edit conflict: vault changed during validation.");
      return { previous, record, data, snapshot, artifacts: encoded.descriptors, requiredDescriptors: encoded.requiredDescriptors, annotation: true, annotationEvidence: extra };
    });
    return this.accept(input.requestId, intent, prepared, access, actor);
  }
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
  /** Merge one duplicate page into another in a single publication; references resolve on read. */
  async merge(input: MergeInput, access: VaultAccess, actor: string): Promise<Receipt> {
    if (!Check(MergeInput, input) || !input.reason.trim()) throw Error("Invalid merge input.");
    if (input.survivor.id === input.absorbed.id) throw Error("A page cannot be merged into itself.");
    return this.publishPair(input, "merge", access, (data, withdrawn, at) => {
      const survivor = this.activePage(data, input.survivor, "Survivor"), absorbed = this.activePage(data, input.absorbed, "Absorbed");
      if (survivor.type !== absorbed.type) throw Error(`Only pages of the same type can be merged: ${survivor.title} is ${survivor.type}, ${absorbed.title} is ${absorbed.type}. No publication accepted.`);
      for (const evidence of input.evidence ?? []) inspectEvidence(path.join(this.config.root, scopeKey(access.scope)), evidence);
      const plan = planMerge(survivor, absorbed, input, { reason: input.reason, requestId: input.requestId, actor, at });
      return { survivor, absorbed, plan, targetId: absorbed.id, evidence: input.evidence ?? [],
        report: { survivorId: survivor.id, absorbedId: absorbed.id, aliases: plan.aliases, fieldConflicts: plan.fieldConflicts, redirectedRecords: this.namingCount(data, withdrawn, absorbed.id) } };
    });
  }
  /** Undo one merge: the merged page is active again and the survivor loses what the merge added. */
  async unmerge(input: UnmergeInput, access: VaultAccess, actor: string): Promise<Receipt> {
    if (!Check(UnmergeInput, input) || !input.reason.trim()) throw Error("Invalid unmerge input.");
    return this.publishPair(input, "unmerge", access, (data, withdrawn, at) => {
      const survivor = this.activePage(data, input.survivor, "Survivor");
      const matches = data.records.filter(r => r.id === input.merged.id), merged = matches.length === 1 ? matches[0] : undefined;
      if (!merged || !merged.valid || merged.lifecycle !== "merged" || merged.hash !== input.merged.expectedHash || merged.revision !== input.merged.expectedRevision) throw Error(`Merged page unavailable, not merged, or changed: ${input.merged.id}. Reread it with knowledge_record and retry with a new request. No publication accepted.`);
      if (merged.metadata.merged_into !== survivor.id) throw Error(`${merged.title} was merged into ${merged.metadata.merged_into}, not ${survivor.id}. Unmerge it from that page. No publication accepted.`);
      const plan = planUnmerge(survivor, merged, { reason: input.reason, requestId: input.requestId, actor, at });
      return { survivor, absorbed: merged, plan, targetId: merged.id, evidence: [],
        report: { survivorId: survivor.id, absorbedId: merged.id, aliases: plan.aliases, fieldConflicts: [], redirectedRecords: this.namingCount(data, withdrawn, merged.id, true) } };
    });
  }
  // Current records whose authored references name `id` (directly, or through pages merged into it).
  private namingCount(data: Prepared["data"], withdrawn: Set<string>, id: string, authored = false) {
    const redirects = mergeRedirects(data.records), names = (ref: string) => ref === id || redirects.get(ref) === id;
    const records = authored ? data.records.filter(r => r.valid && r.lifecycle === "active") : eligible(data, withdrawn, false);
    return records.filter(r => r.id !== id && [...referenceIds(r.metadata), ...(r.metadata.source_page ? [r.metadata.source_page] : [])].some(names)).length;
  }
  // One exact, active, valid page matching its revision fence.
  private activePage(data: Prepared["data"], fence: { id: string; expectedRevision: number; expectedHash: string }, role: string): LoadedRecord {
    const matches = data.records.filter(r => r.id === fence.id), page = matches.length === 1 ? matches[0] : undefined;
    if (page?.lifecycle === "merged") throw Error(`${role} page ${page.title} was already merged into ${page.metadata.merged_into}. Use that page instead. No publication accepted.`);
    if (!page || !page.valid || page.kind !== "page" || page.lifecycle !== "active" || page.hash !== fence.expectedHash || page.revision !== fence.expectedRevision) throw Error(`${role} page unavailable, inactive, invalid or changed: ${fence.id}. Reread it with knowledge_record and retry with a new request. No publication accepted.`);
    return page;
  }
  // Shared journal path for merge and unmerge: plan both page revisions, validate them together, publish once.
  private async publishPair(input: MergeInput | UnmergeInput, operation: "merge" | "unmerge", access: VaultAccess,
    plan: (data: Prepared["data"], withdrawn: Set<string>, at: string) => { survivor: LoadedRecord; absorbed: LoadedRecord; plan: { survivor: LoadedRecord; absorbed: LoadedRecord }; targetId: string; evidence: import("./model.js").Evidence[]; report: MergeReport }): Promise<Receipt> {
    access.assertCurrent();
    if (!this.config.writesEnabled) throw Error("Knowledge writes are disabled.");
    if (input.expectedVaultId && input.expectedVaultId !== this.config.vaultId) throw Error("Connected vault changed; no publication accepted.");
    await this.initialize(access);
    const scope = scopeKey(access.scope), intent = digest(canonical({ operation, input }));
    const prior = this.store.withDatabase(db => this.row(db, scope, input.requestId));
    if (prior) { this.checkReplay(prior, intent); return this.resume(access, input.requestId); }
    this.assertReadable();
    const prepared = await this.real.run(access, async vault => {
      const snapshot = new PublicationFiles(this.config.root).snapshot(scope), data = await vault.scan();
      const withdrawn = this.store.withDatabase(db => withdrawnIds(db, this.retrievalBinding(access)));
      const planned = plan(data, withdrawn, new Date().toISOString());
      // Both revisions are stored with compact evidence, exactly like any other page save.
      const read = (p: string) => readSourceDescriptor(path.join(this.config.root, scope), p);
      const survivor = encodeRecordEvidence(planned.plan.survivor, read), absorbed = encodeRecordEvidence(planned.plan.absorbed, read);
      const artifacts = { ...survivor.descriptors, ...absorbed.descriptors };
      const preview = await vault.scan({ records: [survivor.record, absorbed.record], artifacts });
      for (const record of [survivor.record, absorbed.record]) if (!record.valid) throw Error(`${operation === "merge" ? "Merge" : "Unmerge"} validation failed for ${record.title}: ` + preview.issues.filter(i => i.path === record.path).map(i => i.message).join("; "));
      if (new PublicationFiles(this.config.root).snapshot(scope) !== snapshot) throw Error("Edit conflict: vault changed during validation.");
      return { previous: planned.survivor, record: survivor.record, additional: [{ before: planned.absorbed, after: absorbed.record }], data, snapshot, artifacts,
        requiredDescriptors: { ...survivor.requiredDescriptors, ...absorbed.requiredDescriptors }, metadataOnly: true, annotationEvidence: planned.evidence,
        merge: { operation, targetId: planned.targetId, reason: input.reason, report: planned.report } } satisfies Prepared;
    });
    return this.accept(input.requestId, intent, prepared, access, "agent");
  }
  /** Publishes or clears one owner-approved recall block through the normal journal. */
  async recall(input: Static<typeof RecallInput>, access: VaultAccess, actor: string): Promise<Receipt> {
    if (!Check(RecallInput, input)) throw Error("Invalid automatic recall input.");
    access.assertCurrent();
    if (!this.config.writesEnabled) throw Error("Knowledge writes are disabled.");
    const scope = scopeKey(access.scope), intent = digest(canonical({ operation: "recall", input }));
    const prior = this.store.withDatabase(db => this.row(db, scope, input.requestId));
    if (prior) { this.checkReplay(prior, intent); return this.resume(access, input.requestId); }
    this.assertReadable();
    const prepared = await this.real.run(access, async vault => {
      const snapshot = new PublicationFiles(this.config.root).snapshot(scope), data = await vault.scan();
      // Recall can repair a malformed recall block, but not an otherwise ineligible record.
      const allowed = this.store.withDatabase(db => eligible(data, withdrawnIds(db, this.retrievalBinding(access)), false));
      const previous = allowed.find(record => record.id === input.id && record.lifecycle === "active");
      if (!previous || previous.hash !== input.expectedHash || previous.revision !== input.expectedRevision) throw Error("Automatic recall conflict: target is unavailable, inactive, invalid, or changed.");
      if ("set" in input && previous.kind === "claim" && ["source", "agent_inference"].includes(previous.metadata.assertion_origin ?? "")) {
        throw Error("Automatic recall cannot approve externally sourced or agent-inferred claim text as owner context.");
      }
      const now = new Date().toISOString();
      const metadata: Envelope = { ...previous.metadata, revision: previous.revision + 1, updated_at: now };
      // Approval provenance is host-derived. The closed caller schema cannot supply these fields.
      if ("set" in input) metadata.recall = { ...input.set, approved_by: "owner-private", approved_at: now } satisfies Recall;
      else delete metadata.recall;
      // Preserve authored YAML ordering, comments, and every unrelated unknown field.
      const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(previous.raw)!;
      const doc = parseDocument(match[1]);
      doc.set("revision", metadata.revision);
      doc.set("updated_at", metadata.updated_at);
      if (metadata.recall) doc.set("recall", doc.createNode(metadata.recall, { aliasDuplicateObjects: false }));
      else doc.delete("recall");
      parseYaml(doc.toString());
      const raw = `---\n${doc.toString()}---\n${previous.body}`;
      if (Buffer.byteLength(raw) > RECORD_MAX_BYTES || !Check(Envelope, metadata) || (metadata.recall !== undefined && !approvedRecall(metadata.recall))) throw Error("Automatic recall metadata exceeds record limits or is invalid.");
      const record: LoadedRecord = { ...previous, metadata, raw, hash: digest(raw), revision: metadata.revision };
      if (new PublicationFiles(this.config.root).snapshot(scope) !== snapshot) throw Error("Edit conflict: vault changed during automatic recall validation.");
      return { record, previous, data, snapshot, artifacts: {}, metadataOnly: true };
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
    if (Boolean(input.id) !== Boolean(input.expectedHash && input.expectedRevision) || (!input.id && (input.expectedHash || input.expectedRevision))) throw Error("Create must omit id, expectedRevision and expectedHash; the server assigns the record ID. Edit requires all three from knowledge_record. expectedVaultId and expectedOntologyFingerprint are allowed on both. No publication accepted.");
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
    const prepared = await this.real.run(access, vault => this.prepare(vault, input, kind, access, actor, correction, sourceAttachment));
    return this.accept(input.requestId, intent, prepared, access, actor);
  }
  private async prepare(vault: SampleVault, input: SavePage & ClaimInput & RelationshipInput, kind: WriteKind, access: VaultAccess, actor: string,
    correction?: CorrectInput, sourceAttachment?: import("./model.js").Evidence, batch?: { id: string; data: Prepared["data"]; snapshot: string }, bodyEditReason?: string): Promise<Prepared> {
    const scope = scopeKey(access.scope);
    const snapshot = batch?.snapshot ?? new PublicationFiles(this.config.root).snapshot(scope);
    const data = batch?.data ?? await vault.scan();
    if (input.expectedOntologyFingerprint && input.expectedOntologyFingerprint !== data.ontology?.fingerprint) throw Error("Ontology changed; inspect the current definitions before submitting a new request.");
    const corrected = correction ? assertLifecycleTarget(data.records, correction, true) : undefined;
    if (corrected && corrected.kind !== kind) throw Error("A correction must preserve record kind.");
    const allowed = batch ? [] : this.store.withDatabase(db => eligible(data, withdrawnIds(db, this.retrievalBinding(access)), false));
    const references = [...(input.dependencies ?? []), ...(input.entities ?? []), ...[input.from, input.to, input.owner].filter((id): id is string => Boolean(id))];
    const affected = corrected ? new Set([corrected.id, ...lifecycleImpact(data.records, corrected.id).items.map(r => r.id)]) : undefined;
    if (affected && references.some(id => affected.has(id))) throw Error("Replacement cannot depend on its superseded original.");
    // A stale ID of a merged page must not quietly start a new fragment.
    const redirects = mergeRedirects(data.records), stale = [...references, ...(input.source_page ? [input.source_page] : [])].find(id => redirects.has(id));
    if (stale) throw Error(`Reference ${stale} is a page that was merged into ${redirects.get(stale)}. Reference ${redirects.get(stale)} instead. No publication accepted.`);
    if (!batch && references.some(id => !allowed.some(r => r.id === id))) throw Error("Reference unavailable or inactive in this scope.");
    if (!batch && [...(input.entities ?? []), ...[input.from, input.to, input.owner].filter((id): id is string => Boolean(id))].some(id => !allowed.some(r => r.id === id && r.kind === "page"))) throw Error("Entity, owner and endpoint references must be pages.");
    const matches = data.records.filter(r => r.id === input.id);
    const previous = input.id && matches.length === 1 ? matches[0] : undefined;
    if (previous?.lifecycle === "merged") throw Error(`${previous.title} was merged into ${previous.metadata.merged_into}. Edit that page instead. No files were changed.`);
    if (input.id && (!previous || previous.lifecycle !== "active" || !previous.valid || previous.kind !== "page" || previous.hash !== input.expectedHash || previous.revision !== input.expectedRevision)) throw Error("Edit conflict: record changed, disappeared, is ambiguous, or is invalid. No files were changed by this request, and this draft was not saved. Retain your proposed text, reread the current record, and reconcile before creating a new request.");
    const type = kind === "claim" ? input.claim_kind : kind === "relationship" ? input.label : input.type ?? previous?.type;
    const definition = data.ontology?.definitions.find(d => d.definition.name === type && d.definition.kind === kind)?.definition;
    if (kind !== "claim" && !definition) throw Error("Choose a valid type from the current ontology.");
    if (previous && type !== previous.type) throw Error("Type changes are not supported by this page editor.");
    const now = new Date().toISOString(), id = previous?.id ?? batch?.id ?? randomUUID();
    const relative = previous?.path ?? recordPath(kind === "claim" ? "claims/" : definition!.directory, input.title, id, candidate => existsSync(path.join(this.config.root, scope, candidate)));
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
    const portable = [...Object.keys(RecordAnnotations.properties), "aliases", "tags", "dependencies", ...(kind === "page" ? [] : ["attribution", "evidence", "valid_from", "valid_until", "expires_at"]),
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
      metadata.evidence = [...(metadata.evidence ?? []), { path: artifact, sha256: digest(input.source.text), attribution: input.source.attribution, start_line: 1, end_line: input.source.text.split(/\r?\n/).length }];
      // Attribution travels with the portable page, not only in the receipt.
      metadata.attribution = input.source.attribution;
    }
    const extra = annotationEvidence(metadata);
    if (extra.length) metadata.evidence = [...new Map([...(metadata.evidence ?? []), ...extra].map(e => [canonical(e), e])).values()];
    let yaml: string;
    if (previous) {
      const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(previous.raw)!;
      const doc = parseDocument(match[1]);
      doc.delete("acceptance");
      for (const key of ["title", "revision", "updated_at", ...portable.filter(key => (input as Record<string, unknown>)[key] !== undefined), ...(input.fields !== undefined ? ["fields"] : []), ...(input.source ? ["evidence", "attribution"] : input.attachments?.length || extra.length ? ["evidence"] : [])]) doc.set(key, doc.createNode((metadata as Record<string, unknown>)[key], { aliasDuplicateObjects: false }));
      if (bodyEditReason !== undefined) doc.set("body_change", { reason: bodyEditReason, request_id: input.requestId, at: now });
      yaml = doc.toString();
    } else yaml = stringify(metadata, { aliasDuplicateObjects: false });
    const raw = `---\n${yaml}---\n${input.body}`;
    // Validate the serialized representation too: annotation support may reuse
    // evidence objects, but the portable reader deliberately rejects aliases.
    parseYaml(yaml);
    if (!Check(Envelope, metadata)) throw Error("Record has invalid metadata.");
    let record: LoadedRecord = { id, title: input.title, kind, type: type!, path: relative, revision, lifecycle: metadata.lifecycle, metadata, raw, body: input.body, hash: digest(raw), valid: true };
    const encoded = encodeRecordEvidence(record, p => readSourceDescriptor(path.join(this.config.root, scope), p));
    record = encoded.record; Object.assign(artifacts, encoded.descriptors);
    if (Buffer.byteLength(record.raw) > RECORD_MAX_BYTES) throw Error("Record exceeds limits.");
    if (!batch) {
      const preview = await vault.scan({ record, artifacts });
      if (!record.valid) throw Error("Record validation failed: " + preview.issues.filter(i => i.path === relative).map(i => i.code).join(", "));
    }
    if (!batch && new PublicationFiles(this.config.root).snapshot(scope) !== snapshot) throw Error("Edit conflict: vault changed during validation.");
    const additional = corrected && correction ? [{ before: corrected, after: lifecycleRecord(corrected, "superseded", correction, actor, id) }] : undefined;
    return { record, artifacts, requiredDescriptors: encoded.requiredDescriptors, previous, data, snapshot, additional, lifecycle: correction };
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
      // A descriptor already read during preparation cannot disappear and be recreated.
      for (const [p, raw] of Object.entries(prepared.requiredDescriptors ?? {})) {
        if (readSourceDescriptor(path.join(this.config.root, scope), p) !== raw) throw Error("Source descriptor changed during validation.");
      }
      // Fence the exact snapshot used for schema and reference validation.
      for (const r of prepared.data.records) if (files.hash(`${scope}/${r.path}`) !== r.hash) throw Error("Edit conflict: vault changed during validation.");
      for (const source of prepared.data.sources.filter(s => !s.path.startsWith("bundled:"))) {
        if (files.read(`${scope}/${source.path}`) !== source.raw) throw Error("Ontology changed during validation.");
      }
      // Batches cite the same retained transcript many times; read each file once.
      const cited = new EvidenceInspector(path.join(this.config.root, scope));
      for (const evidence of prepared.annotation || prepared.metadataOnly || (prepared.lifecycle && !("replacement" in prepared.lifecycle)) ? [] : prepared.record.metadata.evidence ?? []) if (!(evidence.path in prepared.artifacts)) cited.inspect(evidence);
      for (const record of prepared.batch ? (prepared.additional ?? []).map(c => c.after) : []) for (const evidence of record.metadata.evidence ?? []) cited.inspect(evidence);
      if (prepared.batch?.source) {
        const prior = this.sourceRow(db, scope, prepared.batch.source);
        if (prior?.request !== prepared.batch.expectedPreviousRequestId) throw Error("Source changed during validation; no batch accepted.");
      }
      for (const evidence of prepared.annotationEvidence ?? []) cited.inspect(evidence);
      const stillActive = eligible(prepared.data, withdrawnIds(db, this.retrievalBinding(access)), false);
      const m = prepared.record.metadata;
      const references = [...(m.dependencies ?? []), ...(m.entities ?? []), ...[m.from, m.to, m.owner].filter((id): id is string => Boolean(id))];
      if (!prepared.batch && !prepared.annotation && !prepared.metadataOnly && (!prepared.lifecycle || "replacement" in prepared.lifecycle) && references.some(id => !stillActive.some(r => r.id === id))) throw Error("Reference unavailable or inactive in this scope.");
      // Bind every descriptor used for validation and every resulting record.
      // New sidecars are journaled; reused sidecars remain explicit replay dependencies.
      for (const record of prepared.data.records) recordSourceDependencies(record, p => readSourceDescriptor(path.join(this.config.root, scope), p));
      const descriptors: Record<string, string> = {};
      for (const record of [prepared.record, ...(prepared.additional ?? []).map(c => c.after)]) {
        Object.assign(descriptors, recordSourceDependencies(record, p => prepared.artifacts[p] ?? readSourceDescriptor(path.join(this.config.root, scope), p)));
      }
      const after = { ...before, generation: before.generation + 1, publicationId: randomUUID() };
      const changes: FileChange[] = [];
      const add = (target: string, old: string | null, raw: string) => {
        const n = changes.length;
        changes.push({ path: target, before: old, after: raw, backup: `${scope}/.knowledge-history/${requestId}/${n}.before`, stage: `${scope}/.knowledge-history/${requestId}/${n}.stage` });
      };
      for (const [p, raw] of Object.entries(prepared.artifacts)) {
        if (p.startsWith("artifacts/sources/")) {
          const existing = files.read(`${scope}/${p}`);
          if (existing !== null) { if (existing !== raw) throw Error("Immutable source descriptor changed."); continue; }
        }
        add(`${scope}/${p}`, null, raw);
      }
      add(`${scope}/${prepared.record.path}`, prepared.previous?.raw ?? null, prepared.record.raw);
      for (const change of prepared.additional ?? []) add(`${scope}/${change.after.path}`, change.before?.raw ?? null, change.after.raw);
      add("vault.json", files.read("vault.json"), JSON.stringify(after) + "\n");
      for (const change of changes) if (files.read(change.path) !== change.before) throw Error("Edit conflict: destination changed or already exists.");
      const receipt: Receipt = { requestId: requestId, state: "accepted", id: prepared.record.id, path: prepared.record.path, revision: prepared.record.revision, hash: prepared.record.hash, at: new Date().toISOString(), message: "Accepted for publication; not yet saved.", indexed: false };
      if (prepared.batch) receipt.items = prepared.batch.items;
      if (prepared.lifecycle) {
        receipt.operation = "replacement" in prepared.lifecycle ? "correct" : "withdraw";
        receipt.targetId = prepared.lifecycle.id;
        if (receipt.operation === "correct") receipt.replacementId = prepared.record.id;
        receipt.reason = prepared.lifecycle.reason;
        receipt.impact = lifecycleImpact(prepared.data.records, prepared.lifecycle.id);
      }
      if (prepared.merge) {
        receipt.operation = prepared.merge.operation; receipt.targetId = prepared.merge.targetId;
        receipt.reason = prepared.merge.reason; receipt.merge = prepared.merge.report;
      }
      const plan: Plan = { descriptors, activity: access.activity, rootIdentity: files.identity(), before, after, changes, actor, agentId: actor === "agent" ? access.agentId : undefined, scope, source: prepared.batch?.source, record: prepared.record, records: [prepared.record, ...(prepared.additional ?? []).map(c => c.after)] };
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
      const fallback = row.state !== "published" && files.read(manifestChange.backup, true, publicationRole(manifestChange.path)) === manifestChange.before ? manifestChange.before : undefined;
      this.identity(db, files, row.state !== "published" ? plan.after : undefined, fallback);
      if (row.state !== "accepted") { access.assertCurrent(); return receipt; }
      const checkpoint = JSON.parse(String(db.prepare("SELECT manifest FROM identities WHERE agent_key=?").get(checkpointKey(this.config.vaultId))!.manifest));
      if (canonical(checkpoint) !== canonical(plan.before)) throw Error("Stale publisher identity");
      try {
        // A reused immutable source is not a file change, but is still fenced on replay.
        for (const [p, raw] of Object.entries(plan.descriptors ?? {})) {
          if (!plan.changes.some(c => c.path === `${plan.scope}/${p}`) && files.read(`${plan.scope}/${p}`) !== raw) throw Error("conflict");
        }
        for (const change of plan.changes) {
          access.assertCurrent();
          files.publish(change, stage => this.hook(`${stage}:${change.path}`));
        }
        this.hook("before-receipt");
        for (const [p, raw] of Object.entries(plan.descriptors ?? {})) if (files.read(`${plan.scope}/${p}`) !== raw) throw Error("conflict");
        for (const change of plan.changes) if (files.read(change.path) !== change.after || (change.before !== null && files.read(change.backup, false, publicationRole(change.path)) !== change.before)) throw Error("conflict");
        access.assertCurrent();
        db.prepare("UPDATE identities SET manifest=? WHERE agent_key=?").run(JSON.stringify(plan.after), checkpointKey(this.config.vaultId));
        receipt.state = "published"; receipt.message = "Published and available to exact reads; keyword indexing is pending until the next search reconciles this scope.";
        const records = plan.records ?? [plan.record];
        observeWithdrawals(db, records, this.retrievalBinding(access));
        for (const record of records) this.recordObservation(db, plan.scope, record, plan.actor, plan.agentId);
        if (plan.activity && plan.agentId) appendActivity(db, plan.scope, plan.agentId, plan.activity, "write", records);
        const gitFiles = new Map(plan.changes.filter(c => c.path !== "vault.json").map(c => [c.path, c.after]));
        for (const [p, raw] of Object.entries(plan.descriptors ?? {})) gitFiles.set(`${plan.scope}/${p}`, raw);
        this.enqueueGit(db, plan.scope, [...gitFiles].map(([path, raw]) => ({ path, raw })), plan.actor, this.publicationToken(plan.scope, requestId));
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
      const fallback = plan && files.identity() === plan.rootIdentity && last && files.read(last.backup, true, publicationRole(last.path)) === last.before ? last.before : undefined;
      this.identity(db, files, plan?.after, fallback);
      const scope = scopeKey(access.scope), offset = input.offset ?? 0, limit = input.limit ?? 50;
      const rows = db.prepare("SELECT sequence,id,provenance,at,path,revision,hash FROM history WHERE scope=? AND (? IS NULL OR id=?) ORDER BY sequence DESC LIMIT ? OFFSET ?").all(scope, input.id ?? null, input.id ?? null, limit + 1, offset);
      const mutations = db.prepare("SELECT receipt FROM mutations WHERE scope=? AND (? IS NULL OR json_extract(receipt,'$.id')=? OR json_extract(receipt,'$.targetId')=?) ORDER BY rowid DESC LIMIT ? OFFSET ?").all(scope, input.id ?? null, input.id ?? null, input.id ?? null, limit + 1, offset).map(r => JSON.parse(String(r.receipt)) as Receipt);
      access.assertCurrent();
      return { git: this.gitStatus(db, scope), entries: rows.slice(0, limit) as unknown as { sequence: number; id: string; provenance: string; at: string; path: string; revision: number; hash: string }[], mutations: mutations.slice(0, limit), nextOffset: rows.length > limit || mutations.length > limit ? offset + limit : null };
    });
  }
  revision(access: VaultAccess, sequence: number, input: { offset?: number; maxChars?: number } = {}) {
    this.history(access, { limit: 1 });
    const result = this.store.withDatabase(db => {
      const row = db.prepare("SELECT raw FROM history WHERE scope=? AND sequence=?").get(scopeKey(access.scope), sequence);
      if (!row) return { raw: null, content: null };
      const page = textWindow(String(row.raw), input.offset, input.maxChars);
      return { raw: page.text, content: page.content };
    });
    access.assertCurrent(); return result;
  }
  mutation(access: VaultAccess, requestId: string, input: { includeFiles?: boolean; offset?: number; limit?: number; charOffset?: number; maxChars?: number; contentField?: "before" | "proposed" | "displaced" } = {}) {
    this.history(access, { limit: 1 });
    const result = this.store.withDatabase(db => {
      const row = this.row(db, scopeKey(access.scope), requestId);
      if (!row) return { receipt: null, files: [] };
      const plan: Plan = JSON.parse(row.plan), files = new PublicationFiles(this.config.root);
      return { receipt: JSON.parse(row.receipt) as Receipt, ...(plan.changes.filter(c => c.path !== "vault.json").length > 3 || input.includeFiles === false || input.offset !== undefined || input.limit !== undefined ? {
        totalFiles: plan.changes.length - 1,
        nextOffset: input.includeFiles === false ? null : (input.offset ?? 0) + (input.limit ?? 3) < plan.changes.length - 1 ? (input.offset ?? 0) + (input.limit ?? 3) : null,
      } : {}),
      files: (input.includeFiles === false ? [] : plan.changes.filter(c => c.path !== "vault.json").slice(input.offset ?? 0, (input.offset ?? 0) + (input.limit ?? 3))).map(c => {
        const window = (raw: string | null, field: "before" | "proposed" | "displaced") => {
          if (raw === null) return null;
          const page = textWindow(raw, field === (input.contentField ?? "proposed") ? input.charOffset : 0, input.maxChars);
          return { ...page, content: { ...page.content, hash: digest(raw) } };
        };
        const before = window(c.before, "before"), proposed = window(c.after, "proposed")!, displaced = window(files.read(c.backup, true, publicationRole(c.path)), "displaced");
        return { path: c.path.slice(plan.scope.length + 1), before: before?.text ?? null, proposed: proposed.text,
          displaced: displaced?.text ?? null, content: { before: before?.content ?? null, proposed: proposed.content, displaced: displaced?.content ?? null } };
      }) };
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
  private recordObservation(db: DatabaseSync, scope: string, r: LoadedRecord, provenance: string, agentId?: string) {
    db.prepare("INSERT INTO history(scope,id,provenance,at,path,revision,hash,raw,agent_id) VALUES (?,?,?,?,?,?,?,?,?)").run(scope, r.id, provenance, new Date().toISOString(), r.path, r.revision, r.hash, r.raw, agentId ?? null);
    db.prepare("INSERT OR REPLACE INTO observations VALUES (?,?,?,?,?,?)").run(scope, r.id, r.path, r.hash, r.revision, r.raw);
  }
  private observe(records: LoadedRecord[], access: VaultAccess, evidence: EvidenceInspector) {
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
        // Content hashes per file, re-read only when its stamp changed.
        const current = new Map<string, string>();
        const originals = new Map<string, string>();
        for (const [relative, stamp] of JSON.parse(snapshot) as [string, string][]) {
          if (stamp === "directory") continue;
          const known = this.observedHashes.get(relative);
          if (known?.stamp === stamp) { current.set(relative, known.hash); continue; }
          const raw = files.read(relative);
          if (raw === null) throw Error("Vault changed during Git observation.");
          const hash = digest(raw);
          if (settledStamp(stamp)) this.observedHashes.set(relative, { stamp, hash }); else this.observedHashes.delete(relative);
          current.set(relative, hash);
        }
        for (const relative of this.observedHashes.keys()) if (relative.startsWith(`${key}/`) && !current.has(relative)) this.observedHashes.delete(relative);
        for (const r of records) {
          if (current.get(`${key}/${r.path}`) !== r.hash) throw Error("Vault changed during Git observation.");
          for (const [p, raw] of Object.entries(recordSourceDependencies(r, p => readSourceDescriptor(path.join(this.config.root, key), p)))) current.set(`${key}/${p}`, digest(raw));
          for (const file of [...(r.metadata.evidence ?? []), ...annotationEvidence(r.metadata)]) {
            if (!file.path.startsWith("artifacts/")) continue;
            const relative = `${key}/${file.path}`;
            try {
              const checked = evidence.inspect(file);
              // Match gbrain's Git sidecar routing threshold; media/large originals
              // remain in the local vault, outside automatic Git snapshots.
              const media = /^(image|audio|video)\//.test(file.mediaType ?? "") || /\.(png|jpe?g|gif|webp|mp[34]|mov|wav|ogg|flac)$/i.test(file.filename ?? file.path);
              if (!media && checked.size < 100 * 1024 * 1024) originals.set(relative, file.sha256);
            } catch { /* Validation already reports unsafe/missing evidence. */ }
          }
        }
        const prior = new Map(db.prepare("SELECT path,hash FROM git_files WHERE scope=?").all(key).map(r => [String(r.path), String(r.hash)]));
        const changes: GitChange[] = [...current].filter(([p, hash]) => prior.get(p) !== hash).map(([path, hash]) => {
          const raw = files.read(path);
          if (raw === null || digest(raw) !== hash) throw Error("Vault changed during Git observation.");
          return { path, raw };
        });
        for (const [path, fileHash] of originals) if (prior.get(path) !== fileHash) changes.push({ path, raw: null, fileHash });
        // Artifacts are retained originals; absent references are not deletions.
        for (const p of prior.keys()) if (!current.has(p) && !p.startsWith(`${key}/artifacts/`)) changes.push({ path: p, raw: null });
        if (files.snapshot(key, true) !== snapshot) throw Error("Vault changed during Git observation.");
        this.enqueueGit(db, key, changes, "external observation");
      }
      // Count IDs once: records with a duplicated ID are not observed.
      const idCounts = new Map<string, number>();
      for (const r of records) idCounts.set(r.id, (idCounts.get(r.id) ?? 0) + 1);
      // Never materialize stored raw text just to compare hashes.
      const priorOf = db.prepare("SELECT path,hash,revision FROM observations WHERE scope=? AND id=?");
      const exactWriter = db.prepare("SELECT provenance,agent_id,sequence FROM history WHERE scope=? AND id=? AND hash=? ORDER BY sequence DESC LIMIT 1");
      const convertedWriter = db.prepare("SELECT provenance,agent_id FROM history WHERE scope=? AND id=? AND sequence<? AND provenance!='conversion' ORDER BY sequence DESC LIMIT 1");
      for (const r of records.filter(r => r.valid && idCounts.get(r.id) === 1)) {
        const prior = priorOf.get(key, r.id);
        if (prior && (prior.hash !== r.hash || prior.path !== r.path)) r.revision = Math.max(r.revision, Number(prior.revision) + 1);
        else if (prior) r.revision = Math.max(r.revision, Number(prior.revision));
        if (!prior || prior.hash !== r.hash || prior.path !== r.path) this.recordObservation(db, key, r, prior ? "external-edit" : "observed");
        // Only journal-confirmed agent revisions may carry an agent byline.
        // Scope ownership alone is not authorship (operator/import/external edits).
        // In a shared store the writer is whichever agent published, never the viewer.
        // A store conversion rewrote only the storage envelope; authorship stays
        // with the revision it converted.
        const exact = exactWriter.get(key, r.id, r.hash);
        const writer = exact?.provenance === "conversion" ? convertedWriter.get(key, r.id, exact.sequence!) : exact;
        if (writer?.provenance === "agent" && writer.agent_id) r.writtenByAgentId = String(writer.agent_id);
      }
      const present = new Set(records.map(r => r.id));
      for (const prior of db.prepare("SELECT id,path,revision FROM observations WHERE scope=? AND hash!=''").all(key)) if (!present.has(String(prior.id))) {
        db.prepare("INSERT INTO history(scope,id,provenance,at,path,revision,hash,raw) VALUES (?,?,?,?,?,?,?,?)").run(key, prior.id!, "external-unavailable", new Date().toISOString(), prior.path!, Number(prior.revision) + 1, "", "");
        db.prepare("UPDATE observations SET hash='',revision=revision+1 WHERE scope=? AND id=?").run(key, prior.id!);
      }
    });
    this.store.withDatabase(db => applyLifecycleGuards(db, records, this.retrievalBinding(access)));
    this.flushGit(access);
  }
}
