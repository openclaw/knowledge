import { Type, type Static } from "typebox";
import { text, name, Evidence, Envelope, id, strings } from "./model.js";
export const requestId = Type.String({ pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$" });
export const SavePage = Type.Object({
  requestId, title: Type.String({ minLength: 1, maxLength: 200 }), body: text(48000),
  type: Type.Optional(name), fields: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  id: Type.Optional(Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{7,95}$" })),
  expectedVaultId: Type.Optional(requestId),
  expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
  expectedHash: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
  expectedOntologyFingerprint: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
  aliases: Type.Optional(strings), tags: Type.Optional(strings), dependencies: Envelope.properties.dependencies,
  attachments: Type.Optional(Type.Array(Evidence)),
  source: Type.Optional(Type.Object({ text: Type.String({ minLength: 1 }), attribution: Type.String({ minLength: 1, maxLength: 1000 }) }, { additionalProperties: false })),
}, { additionalProperties: false });
export type SavePage = Static<typeof SavePage>;
const common = {
  requestId, expectedVaultId: Type.Optional(requestId),
  expectedOntologyFingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  title: Type.String({ minLength: 1, maxLength: 200 }), body: text(48000),
  attribution: Type.String({ minLength: 1, maxLength: 1000 }),
  evidence: Type.Array(Evidence, { minItems: 1 }),
  dependencies: Envelope.properties.dependencies,
  valid_from: Envelope.properties.valid_from, valid_until: Envelope.properties.valid_until,
  expires_at: Envelope.properties.expires_at,
};
export const CreateClaim = Type.Object({
  ...common,
  ...Type.Required(Type.Pick(Envelope, ["claim_kind", "assertion_origin"])).properties,
  entities: Envelope.properties.entities, occurred_at: Envelope.properties.occurred_at,
  owner: Envelope.properties.owner, due_at: Envelope.properties.due_at,
}, { additionalProperties: false });
// Remove Optional markers inherited from the portable (multi-kind) envelope.
export const ClaimInput = CreateClaim;
export type ClaimInput = Static<typeof ClaimInput>;
export const RelationshipInput = Type.Object({
  ...common, from: id, to: id, label: name,
  fields: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
}, { additionalProperties: false });
export type RelationshipInput = Static<typeof RelationshipInput>;
/** Lifecycle changes are explicit, revision-fenced operations, not editable fields. */
const target = {
  requestId, id, expectedRevision: Type.Integer({ minimum: 1 }),
  expectedHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  expectedVaultId: Type.Optional(requestId), reason: Type.String({ minLength: 1, maxLength: 2000 }),
};
export const WithdrawInput = Type.Object(target, { additionalProperties: false });
export type WithdrawInput = Static<typeof WithdrawInput>;
export const CorrectInput = Type.Object({
  ...target, expectedOntologyFingerprint: common.expectedOntologyFingerprint,
  replacement: Type.Union([
    Type.Object({ kind: Type.Literal("claim"), ...Type.Omit(ClaimInput, ["requestId", "expectedVaultId", "expectedOntologyFingerprint"]).properties }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal("relationship"), ...Type.Omit(RelationshipInput, ["requestId", "expectedVaultId", "expectedOntologyFingerprint"]).properties }, { additionalProperties: false }),
  ]),
}, { additionalProperties: false });
export type CorrectInput = Static<typeof CorrectInput>;
export const LifecycleImpact = Type.Object({
  items: Type.Array(Type.Object({ id, title: text(200), kind: text(40), direct: Type.Boolean() }, { additionalProperties: false }), { maxItems: 500 }),
  total: Type.Integer({ minimum: 0 }),
  message: text(1000),
}, { additionalProperties: false });
export type WriteInput = SavePage | ClaimInput | RelationshipInput;
export type WriteKind = "page" | "claim" | "relationship";
export const GitCheckpoint = Type.Object({
  state: Type.Union([Type.Literal("pending"), Type.Literal("unavailable"), Type.Literal("committed")]),
  commit: Type.Optional(Type.String({ pattern: "^[a-f0-9]{40,64}$" })), message: text(500),
}, { additionalProperties: false });
export const GitStatus = Type.Object({
  state: Type.Union([Type.Literal("idle"), Type.Literal("read-only"), ...GitCheckpoint.properties.state.anyOf]),
  pending: Type.Integer({ minimum: 0 }), message: text(500),
}, { additionalProperties: false });
export const Receipt = Type.Object({
  requestId, state: Type.Union([Type.Literal("accepted"), Type.Literal("published"), Type.Literal("conflict")]),
  id: text(96), path: text(500), revision: Type.Integer(), hash: text(64),
  at: text(40), message: text(1000),
  operation: Type.Optional(Type.Union([Type.Literal("correct"), Type.Literal("withdraw")])),
  targetId: Type.Optional(id), replacementId: Type.Optional(id), reason: Type.Optional(text(2000)),
  impact: Type.Optional(LifecycleImpact), indexed: Type.Literal(false), git: Type.Optional(GitCheckpoint),
}, { additionalProperties: false });
export type Receipt = Static<typeof Receipt>;
export const HistoryEntry = Type.Object({
  sequence: Type.Integer(), id: text(96), provenance: text(40), at: text(40),
  path: text(500), revision: Type.Integer(), hash: text(64),
}, { additionalProperties: false });
