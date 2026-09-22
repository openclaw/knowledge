import { Type, type Static } from "typebox";

export const text = (max = 200) => Type.String({ maxLength: max });
const name = Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$" });
const id = Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{7,95}$" });
const timestamp = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$" });
const strings = Type.Array(text(), { maxItems: 100 });
export const Evidence = Type.Object({
  path: text(500), sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  start_line: Type.Integer({ minimum: 1 }), end_line: Type.Integer({ minimum: 1 }),
  quote: Type.Optional(text(4000)),
}, { additionalProperties: false });
export const Envelope = Type.Object({
  format: Type.Literal("knowledge-record-v1"), id, revision: Type.Integer({ minimum: 1 }),
  kind: Type.Union([Type.Literal("page"), Type.Literal("claim"), Type.Literal("relationship")]),
  title: Type.String({ minLength: 1, maxLength: 200 }),
  scope: Type.Object({ visibility: Type.Literal("sample") }, { additionalProperties: false }),
  recorded_at: timestamp, updated_at: timestamp,
  acceptance: Type.Union([Type.Literal("candidate"), Type.Literal("accepted")]),
  lifecycle: Type.Union([Type.Literal("active"), Type.Literal("superseded"), Type.Literal("withdrawn")]),
  aliases: Type.Optional(strings), tags: Type.Optional(strings),
  type: Type.Optional(name), fields: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  claim_kind: Type.Optional(Type.Union([Type.Literal("fact"), Type.Literal("preference"), Type.Literal("decision"), Type.Literal("commitment"), Type.Literal("event"), Type.Literal("belief")])),
  assertion_origin: Type.Optional(Type.Union([Type.Literal("source"), Type.Literal("user_belief"), Type.Literal("agent_inference")])),
  attribution: Type.Optional(text(1000)), entities: Type.Optional(Type.Array(id, { maxItems: 100 })),
  from: Type.Optional(id), to: Type.Optional(id), label: Type.Optional(name),
  evidence: Type.Optional(Type.Array(Evidence, { maxItems: 20 })),
  dependencies: Type.Optional(Type.Array(id, { maxItems: 100 })),
}, { additionalProperties: true });
export type Envelope = Static<typeof Envelope>;

const Field = Type.Object({
  name, label: text(), type: Type.Union([Type.Literal("string"), Type.Literal("number"), Type.Literal("boolean"), Type.Literal("string[]")]),
  required: Type.Boolean(), values: Type.Optional(strings),
}, { additionalProperties: false });
export const Definition = Type.Object({
  format: Type.Literal("knowledge-schema-v1"), version: Type.String({ maxLength: 40, pattern: "^\\d+\\.\\d+\\.\\d+$" }),
  name, label: text(), description: text(2000),
  kind: Type.Union([Type.Literal("page"), Type.Literal("relationship")]),
  directory: Type.String({ pattern: "^[a-z][a-z0-9_-]*/$" }),
  fields: Type.Array(Field, { maxItems: 50 }),
  from_types: Type.Optional(strings), to_types: Type.Optional(strings),
}, { additionalProperties: false });
export type Definition = Static<typeof Definition>;
export type Issue = { path: string; code: string; message: string };
export type RecordSummary = {
  id: string; title: string; kind: string; type: string; path: string;
  acceptance: string; lifecycle: string; revision: number; valid: boolean;
};
export type LoadedRecord = RecordSummary & { metadata: Envelope; body: string; raw: string; hash: string };
export type SchemaReport = { path: string; raw: string; valid: boolean; definition: Definition | null };
