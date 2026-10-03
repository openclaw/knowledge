import { SessionActivityInput, SessionActivityOutput } from "./session-activity.js";
import { BatchInput, SourceCheckInput, SourceCheckOutput, VerifyInput, VerifyOutput } from "./ingestion-contract.js";
import { ConnectionsInput, ConnectionsOutput } from "./connections-contract.js";
import { RecentInput, RecentOutput } from "./recent.js";
import { AttachInput, AttachOutput, AttachmentInput, AttachmentOutput } from "./attachment-contract.js";
import { SearchInput, SearchOutput, LookupInput, LookupOutput } from "./retrieval-contract.js";
import { Type } from "typebox";
import { defineFeatureContract } from "openclaw/plugin-sdk/feature-contract";
import { text } from "./model.js";
import { RecordInput, RecordOutput, OntologyInput, OntologyOutput, CardSummary, Summary } from "./inspection-contract.js";

import { AgentProxyInput, StoreState, StoresChangeInput, StoresChangeOutput, StoresSnapshot } from "./stores-contract.js";
import { AnnotateInput, SavePage, ClaimInput, RelationshipInput, CorrectInput, WithdrawInput, RecallInput, Receipt, HistoryEntry, GitStatus, requestId } from "./mutation-contract.js";

const empty = Type.Object({}, { additionalProperties: false });
const issue = Type.Object({ path: text(500), code: text(80), message: text(1000) });
const record = CardSummary;
const issues = Type.Array(issue, { maxItems: 1000 });
export const contract = defineFeatureContract({
  pluginId: "knowledge",
  operations: {
    session_activity: { kind: "query", description: "Operator-only session activity inspection. Current eligible records only; reads are best effort, writes retain original host session provenance.", input: SessionActivityInput, output: SessionActivityOutput },
    verify: {
      kind: "query", description: "Verify up to 100 published records in one bounded structural check: current eligibility, retained evidence, references, reconciled indexing and supplied expectations. Expected revision/hash and owner/dates/source_page/from/to/label compare exactly; null asserts absence, omitted skips. expectedEntities/expectedDependencies require membership, allowing extras. expectedLinks requires authored links resolving to supplied IDs, optionally at an exact resolver href; automatic backlinks do not count. Derive expectations from intended work, not saved output. Returns counts and exceptions only (20/page, max 50); follow nextOffset with unchanged records and snapshot. Does not evaluate meaning, speaker attribution, chronology, quote wording or source completeness.",
      input: VerifyInput, output: VerifyOutput, tool: { name: "knowledge_verify", label: "Verify knowledge publication" },
    },
    source_check: {
      kind: "query", description: "Check a provider/source key plus exact retained-byte SHA-256 before repeat ingestion. Returns missing, unchanged or changed and the latest scoped batch receipt, even if publication needs recovery. Does not search legacy individual publications, infer semantic equivalence, or prove outputs remain current. Verify returned IDs; never resurrect inactive records. Changed bytes require explicit reconciliation against the prior requestId.",
      input: SourceCheckInput, output: SourceCheckOutput, tool: { name: "knowledge_source_check", label: "Check ingested source" },
    },
    publish_batch: {
      kind: "action", description: "Publish 1–25 items; max 1 MiB. Unique item keys: 1–40 characters, start with lowercase a-z, then only a-z, 0-9, _ or - (e.g. josh_lehman, not JoshLehman). Refs must match keys exactly. Batch-level UUID, vault ID, ontology hash. Refs: @key; body links: [[@key|label]]. Upload evidence first; no inline source. Page edit: existing id + revision + hash. Arrays/fields replace; omitted preserves. Validate all, then journal. Retry: same UUID + payload, or knowledge_resume. Source unchanged: old receipt; new payload ignored. Source changed: reconcile, set expectedPreviousRequestId. Receipt state/Git applies to all items. No dedup, correction or rollback.",
      input: BatchInput, output: Receipt, tool: { name: "knowledge_publish_batch", label: "Publish knowledge batch" },
    },
    annotate: {
      kind: "action", description: "Revision-fenced, evidence-backed metadata annotation without changing assertion text or lifecycle. Set source-page association, identity uncertainty/candidates, speaker-attribution confidence, continuity links, or explicit fixture classification; append retained evidence to an unchanged assertion. Omitted fields are preserved; supplied arrays replace. Only fixture classification may change historical records. Similarity is not supersession, candidate identity is not a merge, and source grouping is not an ingestion batch. Inspect the target and evidence first; a reason and exact revision/hash are required.",
      input: AnnotateInput, output: Receipt,
      tool: { name: "knowledge_annotate", label: "Annotate knowledge context" },
    },
    recent: {
      kind: "query", description: "Read scoped activity with one item per published correction/withdrawal. Cursor paging pins an upper history sequence; current eligibility is rechecked on every read. Inactive assertion content stays in explicit history. Imports are observations, not inferred creations.",
      input: RecentInput, output: RecentOutput,
    },
    attach: {
      kind: "action", description: "UPLOAD source bytes: use knowledge_attach (verb), not knowledge_attachment (read). Retain an original source file in the authorized vault scope. Generate a distinct lowercase UUID requestId per file, never a filename/source ID and never shared by different files. Send base64 chunks of up to 48 KiB decoded, sequential byte offsets, the same requestId/filename/attribution for all chunks, and final=true on the last chunk. Retry identical chunks after interruption. No total file-size or evidence-count cap. A complete receipt returns evidence to append via save_page.attachments. Uploading alone does not create a page. No local filesystem path is accepted.",
      input: AttachInput, output: AttachOutput, tool: { name: "knowledge_attach", label: "Attach knowledge source file" },
    },
    attachment: {
      kind: "query", description: "DOWNLOAD retained bytes: use knowledge_attachment, not knowledge_attach (upload). Read the original bytes of a file referenced by an authorized record. Supply the evidence path and sha256 from knowledge_record. Returns a base64 chunk; follow nextOffset until null. Binary files are preserved without text conversion. No arbitrary filesystem paths or unreferenced files are exposed.",
      input: AttachmentInput, output: AttachmentOutput, tool: { name: "knowledge_attachment", label: "Read knowledge source file" },
    },
    save_page: {
      kind: "action", description: "Create or edit a page in the authorized scope. requestId must be a generated lowercase UUID, never a source ID or slug; it may be omitted only during a host pre-compaction memory flush, when Knowledge derives it from the flush ID and normalized title. Creates omit id/expectedRevision/expectedHash; edits require all three from knowledge_record. Reuse requestId and identical payload for retries; inspect knowledge_mutation after an uncertain result. Calls share a serialized service lane, not a multi-record transaction. Aliases, tags, dependencies and fields replace their collections when supplied (empty clears); omission preserves on edit. Optional expectedOntologyFingerprint fences the observed schema. Append file evidence returned by knowledge_attach using attachments (no count cap). Legacy source text remains supported; saved pages are immediately available with no approval step. A published receipt is a completed save; accepted publication conflicts retain recovery material and block publication. Requests rejected before acceptance are not saved.",
      input: SavePage, output: Receipt, tool: { name: "knowledge_save_page", label: "Save knowledge page" },
    },
    create_claim: {
      kind: "action", description: "Publish one evidence-backed claim (fact, preference, decision, commitment, event or belief). Agent chooses what the source supports; no automatic extraction or semantic deduplication. Required current ontology fingerprint comes from knowledge_ontology. Explicit attribution and assertion_origin distinguish source statements, user beliefs and agent inference. Unknown owner/dates remain absent. occurred_at and due_at preserve date-only or offset timestamp precision; validity/expiry are UTC instants. No task is scheduled. Reuse the exact request and payload for retries; no claim overwrite or lifecycle mutation.",
      input: ClaimInput, output: Receipt, tool: { name: "knowledge_create_claim", label: "Create knowledge claim" },
    },
    create_relationship: {
      kind: "action", description: "Publish one directed, evidenced relationship between existing active pages. Inspect knowledge_ontology for label, fields, endpoint constraints and required current fingerprint. Attribution and nonempty retained evidence are mandatory. Same endpoint pair is not automatically merged. Exact retries reuse the receipt. Markdown links are not asserted relationships.",
      input: RelationshipInput, output: Receipt, tool: { name: "knowledge_create_relationship", label: "Create knowledge relationship" },
    },
    correct: {
      kind: "action", description: "Agent-only explicit correction of an exact claim or typed relationship. Inspect the target's revision/hash and current ontology first. Publish a complete evidence-backed replacement of the same kind and supersede the original in one recoverable logical mutation. User correction evidence may be retained with knowledge_attach. Reason is required; contradiction alone is not authorization. Same request/payload returns the same receipt; pending/conflicted publication blocks reads. Receipt includes original/replacement IDs and known unresolved dependencies; no automatic propagation rewrite or erasure.",
      input: CorrectInput, output: Receipt, tool: { name: "knowledge_correct", label: "Correct knowledge" },
    },
    withdraw: {
      kind: "action", description: "Agent-only withdrawal of one exact page, claim, or explicit relationship by ID, observed revision/hash, and reason. Preserves original/evidence/history; not physical erasure. A durable tombstone prevents stale restores from resurrecting the record. Active retrieval excludes known dependents without rewriting them. Withdraw an edge by its record ID, never by endpoint pair. Reuse identical request/payload for retries.",
      input: WithdrawInput, output: Receipt, tool: { name: "knowledge_withdraw", label: "Withdraw knowledge" },
    },
    recall: {
      kind: "action", description: "Owner-private agent tool for explicit automatic-recall approval. Set a short summary plus optional trigger phrases, importance and host project keys on one exact active record; the service supplies approval identity/time. Source and agent-inference claims cannot be approved. Clear removes recall metadata. Revision/hash preconditions and exact request replay use the normal publication receipt and local Git checkpoint path. Corrections do not inherit approval.",
      input: RecallInput, output: Receipt,
      tool: { name: "knowledge_recall", label: "Curate automatic recall" },
    },
    connections: {
      kind: "query", description: "Inspect connections: incoming/outgoing typed relationships, dependents, claims, authored Markdown links and derived backlinks. Default compact view returns identities, directions, endpoints and identity/attribution uncertainty; no evidence or card bodies. Use view=full for metadata and evidence previews, includeCards for claim prose (full only), includeEndpoints for deduplicated endpoint identities. Read knowledge_record for complete provenance. A backlink is derived navigation, not an authored reverse link. Default 20 rows, max 100; complete responses are byte-bounded and may return fewer. Follow nextOffset and compare snapshot, keeping filters/view unchanged. Access and active eligibility precede counts/pagination. historical=true includes inactive/superseded, never withdrawn records.",
      input: ConnectionsInput, output: ConnectionsOutput, tool: { name: "knowledge_connections", label: "Inspect knowledge connections" },
    },
    resume: {
      kind: "action", description: "Resume an accepted publication or retry its local Git checkpoint in the authorized scope after interruption. Does not overwrite conflicts. Use the original requestId.",
      input: Type.Object({ requestId }, { additionalProperties: false }), output: Receipt,
      tool: { name: "knowledge_resume", label: "Resume knowledge publication" },
    },
    revision: {
      kind: "query", description: "Read a retained revision snapshot from authorized history by sequence. The snapshot is historical, not current knowledge.",
      input: Type.Object({ sequence: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }),
      output: Type.Object({ raw: Type.Union([text(65536), Type.Null()]) }),
      tool: { name: "knowledge_revision", label: "Inspect knowledge revision" },
    },
    mutation: {
      kind: "query", description: "Inspect publication recovery, not source uploads or record content. Use includeFiles=false for receipt-only checks; retained before/proposed/displaced files default to 3/page with nextOffset for batches. A null receipt means no accepted page/assertion mutation was found in this scope; it is not an upload receipt. After an uncertain result, replay the original payload/ID, not a replacement request. Does not resolve or overwrite a conflict.",
      input: Type.Object({ requestId, includeFiles: Type.Optional(Type.Boolean()), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })) }, { additionalProperties: false }),
      output: Type.Object({ totalFiles: Type.Optional(Type.Integer()), nextOffset: Type.Optional(Type.Union([Type.Integer(), Type.Null()])), receipt: Type.Union([Receipt, Type.Null()]), files: Type.Array(Type.Object({ path: text(500), before: Type.Union([text(65536), Type.Null()]), proposed: text(65536), displaced: Type.Union([text(65536), Type.Null()]) }), { maxItems: 3 }) }),
      tool: { name: "knowledge_mutation", label: "Inspect knowledge publication" },
    },
    history: {
      kind: "query", description: "Inspect authorized mutation receipts and observed revision history, including pending/conflict states. Not keyword search.",
      input: Type.Object({ id: Type.Optional(text(96)), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }, { additionalProperties: false }),
      output: Type.Object({ git: GitStatus, entries: Type.Array(HistoryEntry, { maxItems: 50 }), mutations: Type.Array(Receipt, { maxItems: 50 }), nextOffset: Type.Union([Type.Integer(), Type.Null()]) }),
      tool: { name: "knowledge_history", label: "Knowledge history" },
    },
    status: {
      kind: "query", description: "Read availability and counts for the authorized scope of this agent's knowledge store.",
      input: empty,
      output: Type.Object({
        service: Type.Literal("knowledge"), phase: Type.Union([Type.Literal("read-only-explorer"), Type.Literal("page-editor"), Type.Literal("structured-writes")]),
        backendRevision: text(80), instanceId: text(80), startedAt: text(40), checkedAt: text(40),
        snapshot: Type.Optional(text(64)),
        vault: text(80), agent: text(80), store: StoreState, message: Type.Optional(text(300)), scope: text(80), writesEnabled: Type.Boolean(),
        live: Type.Union([Type.Literal("stopped"), Type.Literal("watching"), Type.Literal("unavailable")]),
        records: Type.Integer(), validRecords: Type.Integer(), definitions: Type.Integer(), ontologyAvailable: Type.Boolean(), ontologyFingerprint: text(64), issues: Type.Integer(),
      }, { additionalProperties: false }),
      tool: { name: "knowledge_status", label: "Knowledge status" },
    },
    grep: {
      kind: "query", description: "Search for records, including people, projects and pages whose exact stored identity is not already known. Rank authorized valid knowledge by title/alias/body keywords with SQLite FTS5. Default: all word tokens, active records. Saved pages need no approval. mode=any ORs literal words; mode=phrase matches their order. No raw FTS/regex operators. lifecycle=superseded/all includes history, never withdrawn records. Filters apply before ranking. Snippets have revision/hash citations and body line locators. index.state=unavailable and total=null mean failed retrieval, not no matches. Compare index.snapshot across pages; restart on changes. Not exhaustive inventory: use knowledge_records. No embeddings.",
      input: SearchInput, output: SearchOutput, tool: { name: "knowledge_grep", label: "Search knowledge" },
    },
    lookup: {
      kind: "query", description: "Use only when an exact stable ID, full title or declared alias is already known; use knowledge_grep for discovery and after a missing result. No keyword-search fallback. Resolve that exact identity in the trusted scope; returns found, ambiguous or missing without choosing an ambiguous identity. Names/aliases normalize Unicode, case and whitespace; IDs are case-sensitive. Active records by default, with no approval step; historical filters are explicit. Invalid, withdrawn and unavailable dependencies are excluded. Independent of keyword indexing. Use knowledge_record for full inspection and knowledge_records for exhaustive listing.",
      input: LookupInput, output: LookupOutput, tool: { name: "knowledge_lookup", label: "Resolve knowledge identity" },
    },
    records: {
      kind: "query", description: "List current eligible authorized records exhaustively using pagination, with optional kind, ontology type/alias, or ID/title/alias filtering. lifecycle=all is an explicit historical inventory including inactive/invalid records; originals remain available by exact record/history inspection. includeCards adds bounded claim text and card metadata from the same scan, without evidence excerpts. includeEndpoints adds deduplicated current eligible relationship endpoint summaries for this page from the same authorized scan. Responses are bounded by bytes and nested values and may return fewer rows than requested; follow nextOffset, not offset+limit. Oversized individual cards fall back to clickable summaries; use knowledge_record for full content.",
      input: Type.Object({
        offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 500 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        kind: Type.Optional(Type.Union([Type.Literal("page"), Type.Literal("claim"), Type.Literal("relationship")])),
        includeCards: Type.Optional(Type.Boolean()), includeEndpoints: Type.Optional(Type.Boolean()),
        assertionOrigin: Type.Optional(text(30)),
        type: Type.Optional(text(64)), query: Type.Optional(text(200)), lifecycle: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("all")])),
      }, { additionalProperties: false }),
      output: Type.Object({ records: Type.Array(record, { maxItems: 100 }), endpoints: Type.Optional(Type.Array(Summary, { maxItems: 200 })), total: Type.Integer(), offset: Type.Integer(), nextOffset: Type.Union([Type.Integer(), Type.Null()]), checkedAt: text(40), facets: Type.Optional(Type.Object({ kinds: Type.Record(Type.String(), Type.Integer()), origins: Type.Record(Type.String(), Type.Integer()) })) }),
      tool: { name: "knowledge_records", label: "Browse knowledge" },
    },
    record: {
      kind: "query", description: "Inspect ONE record by stable ID. Default content returns body once (up to 12,000 chars), revision/hash, attribution, uncertainty and compact structured metadata (owner/dates/associations/endpoints); no evidence arrays. Use knowledge_verify for aggregate structural checks. metadataView=full for arbitrary ontology fields and complete frontmatter before replacing fields; none for text only. Legacy includeMetadata true/false means full/none; cannot combine selectors. includeEvidence=true for verified citation locators and excerpts (4,000 chars total); paginate evidenceOffset/evidenceLimit with nextEvidenceOffset. includeReferences=true for paged connected summaries. view=summary omits body; raw returns original Markdown instead. Complete JSON is byte-bounded: follow content.nextOffset, nextReferenceOffset and nextEvidenceOffset; compare record hashes across pages. omitted lists supplemental previews excluded to fit; use connections, attachments or paged raw for complete detail. Oversized metadata/evidence errors explicitly; raw+metadataView=none without evidence/references is the text fallback. Missing/duplicate IDs return null. Never edit from truncated body.",
      input: RecordInput, output: RecordOutput,
      tool: { name: "knowledge_record", label: "Inspect knowledge" },
    },
    ontology: {
      kind: "query", description: "Inspect authorized ontology with progressive detail. Default catalog lists concise types, descriptions, aliases and counts (50/page). Use view=definitions with name for structured authoring fields, endpoint constraints and provenance (10/page); no serialized duplicate. includeRecords adds up to 20 examples/type; use knowledge_records for exhaustive records. view=sources lists source paths; add sourcePath for YAML only when debugging/editing a source, bounded by maxChars (12,000 default). view=diagnostics pages issues. Follow nextOffset using the same view/filters; source offsets are characters, other offsets are items. Behavior flags describe definitions, not implemented workflows.",
      input: OntologyInput, output: OntologyOutput,
      tool: { name: "knowledge_ontology", label: "Inspect ontology" },
    },
    diagnostics: {
      kind: "query", description: "Read current authorized-scope validation findings. Not a mutation or ingestion history. Files are never repaired or rewritten.",
      input: empty,
      output: Type.Object({ issues, total: Type.Integer(), truncated: Type.Boolean(), checkedAt: text(40) }),
      tool: { name: "knowledge_diagnostics", label: "Vault diagnostics" },
    },
    stores_snapshot: {
      kind: "query", description: "Operator settings: agents, effective store assignments and store inventory. Never creates storage.",
      input: empty, output: StoresSnapshot,
    },
    stores_change: {
      kind: "action", description: "Operator settings: change one agent's store assignment (share its store, use a shared store, or use its own). Requires operator admin access and the current settings revision.",
      input: StoresChangeInput, output: StoresChangeOutput,
    },
    stores_change_status: {
      kind: "query", description: "Operator settings: reconcile and report the outcome of an assignment change by request ID.",
      input: Type.Object({ requestId }, { additionalProperties: false }), output: StoresChangeOutput,
    },
    agent_query: {
      kind: "query", description: "Operator inspection: run one read operation against a selected agent's effective store.",
      input: AgentProxyInput, output: Type.Unknown(),
    },
    agent_action: {
      kind: "action", description: "Operator inspection: run one operator-permitted change against a selected agent's effective store.",
      input: AgentProxyInput, output: Type.Unknown(),
    },
  },
  events: { changed: Type.Object({}, { additionalProperties: false }) },
});
