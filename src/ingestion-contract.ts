import { Type, type Static, type TSchema } from "typebox";
import { id, text, Evidence, RecordAnnotations, Envelope } from "./model.js";
import { SavePage, ClaimInput, RelationshipInput, Receipt, requestId } from "./mutation-contract.js";
const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
export const SourceIdentity = Type.Object({
  provider: Type.String({ minLength: 1, maxLength: 80 }), key: Type.String({ minLength: 1, maxLength: 300 }), sha256: hash,
}, { additionalProperties: false });
export type SourceIdentity = Static<typeof SourceIdentity>;
export const SourceCheckInput = SourceIdentity;
export const SourceCheckOutput = Type.Object({
  state: Type.Union([Type.Literal("missing"), Type.Literal("unchanged"), Type.Literal("changed")]),
  receipt: Type.Union([Receipt, Type.Null()]),
  message: text(1000),
}, { additionalProperties: false });
// IDs accept @key. Prose/evidence untouched. Static type stays string.
const ref = Type.String({ pattern: "^(?:[a-zA-Z0-9][a-zA-Z0-9_-]{7,95}|@[a-z][a-z0-9_-]{0,39})$" });
function localRefs<T extends TSchema>(schema: T) {
  const visit = (value: TSchema): TSchema => {
    const shape = value as { pattern?: string; type?: string; items?: TSchema; properties?: Record<string, TSchema> };
    if (shape.pattern === "^[a-zA-Z0-9][a-zA-Z0-9_-]{7,95}$") { const { pattern, type, ...rest } = shape; return { ...rest, ...ref }; }
    if (shape.type === "array") return { ...value, items: visit(shape.items as TSchema) };
    if (shape.type === "object" && shape.properties) return { ...value, properties: Object.fromEntries(Object.entries(shape.properties).map(([key, child]) => [key, visit(child)])) };
    return value;
  };
  return Type.Unsafe<Static<T>>(visit(schema));
}
const payload = <T extends typeof SavePage | typeof ClaimInput | typeof RelationshipInput>(schema: T) => localRefs(Type.Omit(schema, ["requestId", "expectedVaultId", "expectedOntologyFingerprint", "source"], { additionalProperties: false }));
// Share schemas. Stay below host compaction limits. Same accepted values.
function compactBatchSchema<T extends TSchema>(schema: T) {
  const evidenceShape = JSON.stringify(Evidence);
  // Short local names save schema bytes.
  const shared = new Map(Object.entries({
    k: RecordAnnotations.properties.record_class,
    i: localRefs(RecordAnnotations.properties.identity),
    a: RecordAnnotations.properties.attribution_confidence,
    c: localRefs(RecordAnnotations.properties.continuity),
    r: localRefs(Envelope.properties.dependencies),
  }).map(([name, value]) => [JSON.stringify(value), name]));
  const definitions: Record<string, TSchema> = {};
  const visit = (value: TSchema, define = false): TSchema => {
    const name = shared.get(JSON.stringify(value));
    if (name && !define) {
      definitions[name] ??= visit(value, true);
      return { $ref: `#/$defs/${name}` };
    }
    const { description, ...compact } = value as TSchema & { description?: string };
    value = compact;
    const shape = value as { type?: string; anyOf?: { const?: unknown }[]; properties?: Record<string, TSchema>; items?: TSchema };
    // Share the array, not just its items; $ref siblings retain each use's bounds.
    if (shape.type === "array" && JSON.stringify(shape.items) === evidenceShape) {
      const { type, items, ...bounds } = value as TSchema & { type?: string; items?: TSchema };
      definitions.e ??= { type: "array", items: visit(Evidence) };
      return { ...bounds, $ref: "#/$defs/e" };
    }
    if (shape.anyOf?.every(branch => typeof branch.const === "string")) {
      const { anyOf, ...rest } = shape;
      return { ...rest, type: "string", enum: anyOf.map(branch => branch.const) };
    }
    if (shape.properties) return { ...value, properties: Object.fromEntries(Object.entries(shape.properties).map(([key, child]) => [key, visit(child)])) };
    if (shape.items) return { ...value, items: visit(shape.items) };
    if (shape.anyOf) return { ...value, anyOf: shape.anyOf.map(branch => visit(branch)) };
    return value;
  };
  return Type.Unsafe<Static<T>>({ ...visit(schema), $defs: definitions });
}
export const BatchInput = compactBatchSchema(Type.Object({
  requestId, expectedVaultId: requestId, expectedOntologyFingerprint: hash,
  source: Type.Optional(SourceIdentity),
  expectedPreviousRequestId: Type.Optional(requestId),
  items: Type.Array(Type.Union([
    Type.Object({ key: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,39}$" }), kind: Type.Literal("page"), input: payload(SavePage) }, { additionalProperties: false }),
    Type.Object({ key: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,39}$" }), kind: Type.Literal("claim"), input: payload(ClaimInput) }, { additionalProperties: false }),
    Type.Object({ key: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,39}$" }), kind: Type.Literal("relationship"), input: payload(RelationshipInput) }, { additionalProperties: false }),
  ]), { minItems: 1, maxItems: 25 }),
}, { additionalProperties: false }));
export type BatchInput = Static<typeof BatchInput>;
export type BatchItem = BatchInput["items"][number];
export const VerifyInput = Type.Object({
  records: Type.Array(Type.Object({
    id, expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })), expectedHash: Type.Optional(hash),
    owner: Type.Optional(Type.Union([id, Type.Null()])),
    due_at: Type.Optional(Type.Union([text(40), Type.Null()])),
    occurred_at: Type.Optional(Type.Union([text(40), Type.Null()])),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 100 }),
  offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  snapshot: Type.Optional(hash),
}, { additionalProperties: false });
export type VerifyInput = Static<typeof VerifyInput>;
export const VerifyOutput = Type.Object({
  checked: Type.Integer(), passed: Type.Integer(), failed: Type.Integer(),
  problems: Type.Array(Type.Object({ id, code: text(80), message: text(300) }, { additionalProperties: false }), { maxItems: 50 }),
  totalProblems: Type.Integer(), nextOffset: Type.Union([Type.Integer(), Type.Null()]),
  snapshot: hash, checkedAt: text(40),
  index: Type.Union([Type.Literal("ready"), Type.Literal("unavailable")]),
  message: text(500),
}, { additionalProperties: false });
export type VerifyOutput = Static<typeof VerifyOutput>;
