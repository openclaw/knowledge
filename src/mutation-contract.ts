import { Type, type Static } from "typebox";
import { text, name, Evidence } from "./model.js";
export const requestId = Type.String({ pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$" });
export const SavePage = Type.Object({
  requestId, title: Type.String({ minLength: 1, maxLength: 200 }), body: text(48000),
  type: Type.Optional(name), fields: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  id: Type.Optional(Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{7,95}$" })),
  expectedVaultId: Type.Optional(requestId),
  expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
  expectedHash: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
  attachments: Type.Optional(Type.Array(Evidence)),
  source: Type.Optional(Type.Object({ text: Type.String({ minLength: 1 }), attribution: Type.String({ minLength: 1, maxLength: 1000 }) }, { additionalProperties: false })),
}, { additionalProperties: false });
export type SavePage = Static<typeof SavePage>;
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
  at: text(40), message: text(1000), indexed: Type.Literal(false), git: Type.Optional(GitCheckpoint),
}, { additionalProperties: false });
export type Receipt = Static<typeof Receipt>;
export const HistoryEntry = Type.Object({
  sequence: Type.Integer(), id: text(96), provenance: text(40), at: text(40),
  path: text(500), revision: Type.Integer(), hash: text(64),
}, { additionalProperties: false });
