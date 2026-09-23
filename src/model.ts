import { Type, type Static } from "typebox";

export const text = (max = 200) => Type.String({ maxLength: max });
export const name = Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$" });
export const id = Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{7,95}$" });
export const timestamp = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$" });
export const strings = Type.Array(text(), { maxItems: 100 });
export const Evidence = Type.Object({
  path: text(500), sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  start_line: Type.Optional(Type.Integer({ minimum: 1 })), end_line: Type.Optional(Type.Integer({ minimum: 1 })),
  filename: Type.Optional(text(200)), mediaType: Type.Optional(text(200)), size: Type.Optional(Type.Integer({ minimum: 0 })),
  attribution: Type.Optional(text(1000)),
  quote: Type.Optional(text(4000)),
}, { additionalProperties: false });
export type Evidence = Static<typeof Evidence>;
export const Scope = Type.Union([
  Type.Object({ visibility: Type.Literal("sample") }, { additionalProperties: false }),
  Type.Object({ visibility: Type.Literal("agent-private"), agentId: name }, { additionalProperties: false }),
  Type.Object({ visibility: Type.Literal("conversation"), agentId: name, sessionId: Type.String({ pattern: "^[a-f0-9-]{36}$" }) }, { additionalProperties: false }),
]);
export type Scope = Static<typeof Scope>;
export const Envelope = Type.Object({
  format: Type.Literal("knowledge-record-v1"), id, revision: Type.Integer({ minimum: 1 }),
  kind: Type.Union([Type.Literal("page"), Type.Literal("claim"), Type.Literal("relationship")]),
  title: Type.String({ minLength: 1, maxLength: 200 }),
  scope: Scope,
  recorded_at: timestamp, updated_at: timestamp,
  lifecycle: Type.Union([Type.Literal("active"), Type.Literal("superseded"), Type.Literal("withdrawn")]),
  aliases: Type.Optional(strings), tags: Type.Optional(strings),
  type: Type.Optional(name), fields: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  claim_kind: Type.Optional(Type.Union([Type.Literal("fact"), Type.Literal("preference"), Type.Literal("decision"), Type.Literal("commitment"), Type.Literal("event"), Type.Literal("belief")])),
  assertion_origin: Type.Optional(Type.Union([Type.Literal("source"), Type.Literal("user_belief"), Type.Literal("agent_inference")])),
  occurred_at: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}(?:T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2}))?$" })),
  valid_from: Type.Optional(timestamp), valid_until: Type.Optional(timestamp), expires_at: Type.Optional(timestamp),
  owner: Type.Optional(id), due_at: Type.Optional(Type.String({ maxLength: 40 })),
  attribution: Type.Optional(text(1000)), entities: Type.Optional(Type.Array(id, { maxItems: 100 })),
  from: Type.Optional(id), to: Type.Optional(id), label: Type.Optional(name),
  evidence: Type.Optional(Type.Array(Evidence)),
  dependencies: Type.Optional(Type.Array(id, { maxItems: 100 })),
}, { additionalProperties: true });
export type Envelope = Static<typeof Envelope>;

export const Field = Type.Object({
  name, label: text(), type: Type.Union([Type.Literal("string"), Type.Literal("number"), Type.Literal("boolean"), Type.Literal("string[]")]),
  required: Type.Optional(Type.Boolean()), values: Type.Optional(strings),
}, { additionalProperties: false });
export const Definition = Type.Object({
  name, label: text(), description: text(2000),
  kind: Type.Union([Type.Literal("page"), Type.Literal("relationship")]),
  directory: Type.String({ maxLength: 100, pattern: "^(?:[a-z][a-z0-9_-]*/)+$" }),
  fields: Type.Array(Field, { maxItems: 50 }),
  primitive: Type.Optional(Type.Union([Type.Literal("entity"), Type.Literal("media"), Type.Literal("temporal"), Type.Literal("annotation"), Type.Literal("concept")])),
  aliases: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 100 })),
  path_prefixes: Type.Optional(Type.Array(Type.String({ maxLength: 100, pattern: "^(?:[a-z][a-z0-9_-]*/)+$" }), { maxItems: 100 })),
  behaviors: Type.Optional(Type.Object({ extractable: Type.Boolean(), expert_routing: Type.Boolean() }, { additionalProperties: false })),
  from_types: Type.Optional(strings), to_types: Type.Optional(strings),
}, { additionalProperties: false });
export type Definition = Static<typeof Definition>;
export type Issue = { path: string; code: string; message: string };
export type RecordSummary = {
  id: string; title: string; kind: string; type: string; path: string;
  lifecycle: string; revision: number; valid: boolean;
};
export type LoadedRecord = RecordSummary & { metadata: Envelope; body: string; raw: string; hash: string };
