import { Type } from "typebox";
import { defineFeatureContract } from "openclaw/plugin-sdk/feature-contract";
import { text, Evidence } from "./model.js";

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
      kind: "query", description: "Read sample-vault availability and counts. No private vault is connected; writes are disabled.",
      input: empty,
      output: Type.Object({
        service: Type.Literal("knowledge"), phase: Type.Literal("read-only-explorer"),
        backendRevision: text(80), instanceId: text(80), startedAt: text(40), checkedAt: text(40),
        vault: Type.Literal("bundled-sample"), agent: Type.Literal("none — synthetic sample"), writesEnabled: Type.Literal(false),
        records: Type.Integer(), validRecords: Type.Integer(), schemas: Type.Integer(), issues: Type.Integer(),
      }, { additionalProperties: false }),
      tool: { name: "knowledge_status", label: "Knowledge status" },
    },
    records: {
      kind: "query", description: "List synthetic sample records exhaustively using pagination, with optional kind, type, or ID/title/alias filtering. Not real user knowledge.",
      input: Type.Object({
        offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 500 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        kind: Type.Optional(Type.Union([Type.Literal("page"), Type.Literal("claim"), Type.Literal("relationship")])),
        type: Type.Optional(text(64)), query: Type.Optional(text(200)),
      }, { additionalProperties: false }),
      output: Type.Object({ records: Type.Array(record, { maxItems: 100 }), total: Type.Integer(), offset: Type.Integer(), nextOffset: Type.Union([Type.Integer(), Type.Null()]), checkedAt: text(40) }),
      tool: { name: "knowledge_records", label: "Browse sample knowledge" },
    },
    record: {
      kind: "query", description: "Inspect a synthetic sample record by stable ID, with structured metadata, original Markdown, evidence locators, and direct record references. Missing or duplicate IDs return no record.",
      input: Type.Object({ id: text(96) }, { additionalProperties: false }),
      output: Type.Object({
        record: Type.Union([Type.Intersect([record, Type.Object({ body: text(65536), raw: text(65536), hash: text(64), metadata: text(262144) })]), Type.Null()]),
        issues, references: Type.Array(record, { maxItems: 500 }),
        evidence: Type.Array(Type.Object({ ...Evidence.properties, excerpt: text(4000), verified: Type.Boolean() }, { additionalProperties: false }), { maxItems: 20 }),
      }),
      tool: { name: "knowledge_record", label: "Inspect sample knowledge" },
    },
    schemas: {
      kind: "query", description: "Inspect bundled sample taxonomy definitions, activation validity, affected records, and original YAML. Invalid definitions are not activated.",
      input: empty,
      output: Type.Object({ schemas: Type.Array(Type.Object({ path: text(500), raw: text(65536), valid: Type.Boolean(), name: text(64), version: text(40), label: text(200), kind: text(30), directory: text(100), affectedRecords: Type.Integer(), issues }), { maxItems: 500 }) }),
      tool: { name: "knowledge_schemas", label: "Inspect sample schemas" },
    },
    diagnostics: {
      kind: "query", description: "Read current sample-vault validation findings. Not a mutation or ingestion history. Files are never repaired or rewritten.",
      input: empty,
      output: Type.Object({ issues, total: Type.Integer(), truncated: Type.Boolean(), checkedAt: text(40) }),
      tool: { name: "knowledge_diagnostics", label: "Sample vault diagnostics" },
    },
  },
  events: {},
});
