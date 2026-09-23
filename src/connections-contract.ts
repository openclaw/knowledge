import { Type, type Static } from "typebox";
import { Summary } from "./inspection-contract.js";
import { Evidence, text } from "./model.js";
export const ConnectionsInput = Type.Object({
  id: text(96), historical: Type.Optional(Type.Boolean()),
  direction: Type.Optional(Type.Union([Type.Literal("incoming"), Type.Literal("outgoing"), Type.Literal("dependents"), Type.Literal("claims")])),
  offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
}, { additionalProperties: false });
export const ConnectionsOutput = Type.Object({
  total: Type.Integer(), nextOffset: Type.Union([Type.Integer(), Type.Null()]), snapshot: text(64),
  connections: Type.Array(Type.Object({
    direction: Type.Union([Type.Literal("incoming"), Type.Literal("outgoing"), Type.Literal("dependents"), Type.Literal("claims")]),
    record: Summary, from: Type.Optional(text(96)), to: Type.Optional(text(96)), label: Type.Optional(text(64)),
    evidence: Type.Array(Evidence, { maxItems: 3 }), evidenceTruncated: Type.Boolean(),
  }), { maxItems: 100 }),
}, { additionalProperties: false });
