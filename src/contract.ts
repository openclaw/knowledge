import { AttachInput, AttachOutput, AttachmentInput, AttachmentOutput } from "./attachment-contract.js";
import { SearchInput, SearchOutput, LookupInput, LookupOutput } from "./retrieval-contract.js";
import { Type } from "typebox";
import { defineFeatureContract } from "openclaw/plugin-sdk/feature-contract";
import { text } from "./model.js";
import { RecordInput, RecordOutput, OntologyInput, OntologyOutput, Summary } from "./inspection-contract.js";

import { SavePage, Receipt, HistoryEntry, GitStatus, requestId } from "./mutation-contract.js";

const empty = Type.Object({}, { additionalProperties: false });
const issue = Type.Object({ path: text(500), code: text(80), message: text(1000) });
const record = Summary;
const issues = Type.Array(issue, { maxItems: 1000 });
export const contract = defineFeatureContract({
  pluginId: "knowledge",
  operations: {
    attach: {
      kind: "action", description: "Retain an original source file in the authorized vault scope. Send base64 chunks of up to 48 KiB decoded, sequential byte offsets, the same requestId/filename/attribution for all chunks, and final=true on the last chunk. Retry identical chunks after interruption. No total file-size or evidence-count cap. A complete receipt returns evidence to append via save_page.attachments. Uploading alone does not create a page. No local filesystem path is accepted.",
      input: AttachInput, output: AttachOutput, tool: { name: "knowledge_attach", label: "Attach knowledge source file" },
    },
    attachment: {
      kind: "query", description: "Read the original bytes of a file referenced by an authorized record. Supply the evidence path and sha256 from knowledge_record. Returns a base64 chunk; follow nextOffset until null. Binary files are preserved without text conversion. No arbitrary filesystem paths or unreferenced files are exposed.",
      input: AttachmentInput, output: AttachmentOutput, tool: { name: "knowledge_attachment", label: "Read knowledge source file" },
    },
    save_page: {
      kind: "action", description: "Create or edit a page in the authorized scope. Reuse requestId and identical payload for retries. Edits require observed revision and hash. Append file evidence returned by knowledge_attach using attachments (no count cap). Legacy source text remains supported; saved pages are immediately available with no approval step. A published receipt is a completed save; accepted publication conflicts retain recovery material and block publication. Requests rejected before acceptance are not saved.",
      input: SavePage, output: Receipt, tool: { name: "knowledge_save_page", label: "Save knowledge page" },
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
      kind: "query", description: "Inspect a scoped receipt and retained before/proposed/displaced text for publication recovery. Does not resolve or overwrite a conflict.",
      input: Type.Object({ requestId }, { additionalProperties: false }),
      output: Type.Object({ receipt: Type.Union([Receipt, Type.Null()]), files: Type.Array(Type.Object({ path: text(500), before: Type.Union([text(65536), Type.Null()]), proposed: text(65536), displaced: Type.Union([text(65536), Type.Null()]) }), { maxItems: 2 }) }),
      tool: { name: "knowledge_mutation", label: "Inspect knowledge publication" },
    },
    history: {
      kind: "query", description: "Inspect authorized mutation receipts and observed revision history, including pending/conflict states. Not keyword search.",
      input: Type.Object({ id: Type.Optional(text(96)), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }, { additionalProperties: false }),
      output: Type.Object({ git: GitStatus, entries: Type.Array(HistoryEntry, { maxItems: 50 }), mutations: Type.Array(Receipt, { maxItems: 50 }), nextOffset: Type.Union([Type.Integer(), Type.Null()]) }),
      tool: { name: "knowledge_history", label: "Knowledge history" },
    },
    status: {
      kind: "query", description: "Read availability and counts for the authorized vault scope. Sample mode is read-only.",
      input: empty,
      output: Type.Object({
        service: Type.Literal("knowledge"), phase: Type.Union([Type.Literal("read-only-explorer"), Type.Literal("page-editor")]),
        backendRevision: text(80), instanceId: text(80), startedAt: text(40), checkedAt: text(40),
        vault: text(80), agent: text(80), scope: text(80), sample: Type.Boolean(), writesEnabled: Type.Boolean(),
        live: Type.Union([Type.Literal("stopped"), Type.Literal("watching"), Type.Literal("unavailable")]),
        records: Type.Integer(), validRecords: Type.Integer(), definitions: Type.Integer(), ontologyAvailable: Type.Boolean(), ontologyFingerprint: text(64), issues: Type.Integer(),
      }, { additionalProperties: false }),
      tool: { name: "knowledge_status", label: "Knowledge status" },
    },
    grep: {
      kind: "query", description: "Rank authorized valid knowledge by title/alias/body keywords with SQLite FTS5. Default: all word tokens, active records. Saved pages need no approval. mode=any ORs literal words; mode=phrase matches their order. No raw FTS/regex operators. lifecycle=superseded/all includes history, never withdrawn records. Filters apply before ranking. Snippets have revision/hash citations and body line locators. index.state=unavailable and total=null mean failed retrieval, not no matches. Compare index.snapshot across pages; restart on changes. Not exhaustive inventory: use knowledge_records. No embeddings.",
      input: SearchInput, output: SearchOutput, tool: { name: "knowledge_grep", label: "Search knowledge" },
    },
    lookup: {
      kind: "query", description: "Resolve an exact stable ID, full title or declared alias in the trusted scope; returns found, ambiguous or missing without choosing an ambiguous identity. Names/aliases normalize Unicode, case and whitespace; IDs are case-sensitive. Active records by default, with no approval step; historical filters are explicit. Invalid, withdrawn and unavailable dependencies are excluded. Independent of keyword indexing. Use knowledge_record for full inspection and knowledge_records for exhaustive listing.",
      input: LookupInput, output: LookupOutput, tool: { name: "knowledge_lookup", label: "Resolve knowledge identity" },
    },
    records: {
      kind: "query", description: "List authorized records exhaustively using pagination, with optional kind, ontology type/alias, or ID/title/alias filtering.",
      input: Type.Object({
        offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 500 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        kind: Type.Optional(Type.Union([Type.Literal("page"), Type.Literal("claim"), Type.Literal("relationship")])),
        type: Type.Optional(text(64)), query: Type.Optional(text(200)),
      }, { additionalProperties: false }),
      output: Type.Object({ records: Type.Array(record, { maxItems: 100 }), total: Type.Integer(), offset: Type.Integer(), nextOffset: Type.Union([Type.Integer(), Type.Null()]), checkedAt: text(40) }),
      tool: { name: "knowledge_records", label: "Browse knowledge" },
    },
    record: {
      kind: "query", description: "Read a scoped record by stable ID. Default content view returns body once (12,000 characters), revision/hash, attribution, issues and verified evidence (4,000 excerpt characters total). Follow content.nextOffset with offset to read more; compare hashes across chunks. view=summary omits text; view=raw returns original Markdown instead. Evidence is paginated with evidenceOffset/evidenceLimit and nextEvidenceOffset; preview limits never truncate originals. Full metadata is opt-in as a structured object; references are opt-in and paginated. Missing/duplicate IDs return null. Never edit from a truncated body.",
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
  },
  events: { changed: Type.Object({}, { additionalProperties: false }) },
});
