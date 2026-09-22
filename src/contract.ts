import { Type } from "typebox";
import { defineFeatureContract } from "openclaw/plugin-sdk/feature-contract";
import { text, Evidence, Field } from "./model.js";

const empty = Type.Object({}, { additionalProperties: false });
const issue = Type.Object({ path: text(500), code: text(80), message: text(1000) });
const record = Type.Object({
  id: text(96), title: text(200), kind: text(30), type: text(64), path: text(500),
  acceptance: text(20), lifecycle: text(20), revision: Type.Integer(), valid: Type.Boolean(),
});
const issues = Type.Array(issue, { maxItems: 1000 });
export const contract = defineFeatureContract({
  pluginId: "knowledge",
  operations: {
    status: {
      kind: "query", description: "Read availability and counts for the authorized vault scope. Writes are disabled.",
      input: empty,
      output: Type.Object({
        service: Type.Literal("knowledge"), phase: Type.Literal("read-only-explorer"),
        backendRevision: text(80), instanceId: text(80), startedAt: text(40), checkedAt: text(40),
        vault: text(80), agent: text(80), scope: text(80), sample: Type.Boolean(), writesEnabled: Type.Literal(false),
        records: Type.Integer(), validRecords: Type.Integer(), definitions: Type.Integer(), ontologyAvailable: Type.Boolean(), ontologyFingerprint: text(64), issues: Type.Integer(),
      }, { additionalProperties: false }),
      tool: { name: "knowledge_status", label: "Knowledge status" },
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
      kind: "query", description: "Inspect a authorized record by stable ID, with structured metadata, original Markdown, evidence locators, and direct record references. Missing or duplicate IDs return no record.",
      input: Type.Object({ id: text(96) }, { additionalProperties: false }),
      output: Type.Object({
        record: Type.Union([Type.Intersect([record, Type.Object({ body: text(65536), raw: text(65536), hash: text(64), metadata: text(262144) })]), Type.Null()]),
        issues, references: Type.Array(record, { maxItems: 500 }),
        evidence: Type.Array(Type.Object({ ...Evidence.properties, excerpt: text(4000), verified: Type.Boolean() }, { additionalProperties: false }), { maxItems: 20 }),
      }),
      tool: { name: "knowledge_record", label: "Inspect knowledge" },
    },
    ontology: {
      kind: "query", description: "Inspect the effective authorized-scope ontology: composed definitions, provenance, fingerprint, invalid sources, and affected records. Behavior flags do not enable unimplemented workflows.",
      input: empty,
      output: Type.Object({
        available: Type.Boolean(), name: text(64), version: text(40), fingerprint: text(64), chain: Type.Array(text(110), { maxItems: 8 }),
        definitions: Type.Array(Type.Object({
          name: text(64), label: text(200), kind: text(30), primitive: text(20), directory: text(100), aliases: Type.Array(text(64), { maxItems: 100 }),
          description: text(2000), fields: Type.Array(Field, { maxItems: 50 }), fromTypes: Type.Array(text(200), { maxItems: 100 }), toTypes: Type.Array(text(200), { maxItems: 100 }),
          source: text(500), ontology: text(64), version: text(40), effective: text(262144), affectedRecords: Type.Array(record, { maxItems: 500 }),
        }), { maxItems: 500 }),
        sources: Type.Array(Type.Object({ path: text(500), raw: text(65536), valid: Type.Boolean(), name: text(64), version: text(40) }), { maxItems: 501 }),
        affectedRecords: Type.Array(record, { maxItems: 500 }), issues, totalIssues: Type.Integer(), truncated: Type.Boolean(),
      }),
      tool: { name: "knowledge_ontology", label: "Inspect ontology" },
    },
    diagnostics: {
      kind: "query", description: "Read current authorized-scope validation findings. Not a mutation or ingestion history. Files are never repaired or rewritten.",
      input: empty,
      output: Type.Object({ issues, total: Type.Integer(), truncated: Type.Boolean(), checkedAt: text(40) }),
      tool: { name: "knowledge_diagnostics", label: "Vault diagnostics" },
    },
  },
  events: {},
});
