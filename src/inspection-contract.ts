import { Type, type Static } from "typebox";
import { text, Evidence, Envelope, Field, Definition } from "./model.js";

const optionalBool = () => Type.Optional(Type.Boolean());
const offset = Type.Optional(Type.Integer({ minimum: 0 }));
const limit = Type.Optional(Type.Integer({ minimum: 1, maximum: 100 }));
const maxChars = Type.Optional(Type.Integer({ minimum: 256, maximum: 65536 }));
const nullableOffset = Type.Union([Type.Integer(), Type.Null()]);
export const Summary = Type.Object({
  id: text(96), title: text(200), kind: text(30), type: text(64), path: text(500),
  lifecycle: text(20), revision: Type.Integer(), valid: Type.Boolean(),
});
const Issue = Type.Object({ path: text(500), code: text(80), message: text(1000) });
export const RecordInput = Type.Object({
  id: text(96),
  view: Type.Optional(Type.Union([Type.Literal("content"), Type.Literal("summary"), Type.Literal("raw")])),
  offset, maxChars,
  includeMetadata: optionalBool(), includeEvidence: optionalBool(), includeReferences: optionalBool(),
  referenceOffset: offset, referenceLimit: limit,
  evidenceOffset: offset, evidenceLimit: limit,
  maxEvidenceChars: Type.Optional(Type.Integer({ minimum: 0, maximum: 20000 })),
}, { additionalProperties: false });
export type RecordInput = Static<typeof RecordInput>;
export const RecordOutput = Type.Object({
  view: Type.Union([Type.Literal("content"), Type.Literal("summary"), Type.Literal("raw")]),
  record: Type.Union([Type.Intersect([Summary, Type.Object({
    hash: text(64), body: Type.Optional(text(65536)), raw: Type.Optional(text(65536)),
    metadata: Type.Optional(Envelope), attribution: Type.Optional(text(1000)),
    assertionOrigin: Type.Optional(text(30)), claimKind: Type.Optional(text(30)),
  })]), Type.Null()]),
  content: Type.Object({ offset: Type.Integer(), totalChars: Type.Integer(), nextOffset: nullableOffset }),
  issues: Type.Array(Issue, { maxItems: 1000 }),
  references: Type.Optional(Type.Array(Summary, { maxItems: 100 })),
  referenceTotal: Type.Optional(Type.Integer()), nextReferenceOffset: Type.Optional(nullableOffset),
  evidence: Type.Optional(Type.Array(Type.Object({ ...Evidence.properties, excerpt: text(20000), verified: Type.Boolean(), excerptTruncated: Type.Boolean() }), { maxItems: 100 })),
  evidenceTotal: Type.Optional(Type.Integer()), nextEvidenceOffset: Type.Optional(nullableOffset),
}, { additionalProperties: false });
export type RecordOutput = Static<typeof RecordOutput>;

export const OntologyInput = Type.Object({
  view: Type.Optional(Type.Union([Type.Literal("catalog"), Type.Literal("definitions"), Type.Literal("sources"), Type.Literal("diagnostics")])),
  name: Type.Optional(text(64)), kind: Type.Optional(Type.Union([Type.Literal("page"), Type.Literal("relationship")])),
  offset, limit, includeRecords: optionalBool(),
  sourcePath: Type.Optional(text(500)), maxChars,
}, { additionalProperties: false });
export type OntologyInput = Static<typeof OntologyInput>;
export const OntologyOutput = Type.Object({
  view: Type.Union([Type.Literal("catalog"), Type.Literal("definitions"), Type.Literal("sources"), Type.Literal("diagnostics")]),
  available: Type.Boolean(), name: text(64), version: text(40), fingerprint: text(64),
  total: Type.Integer(), offset: Type.Integer(), nextOffset: nullableOffset,
  definitions: Type.Optional(Type.Array(Type.Object({
    name: text(64), label: text(200), kind: text(30), primitive: text(20), description: text(2000),
    aliases: Type.Array(text(64), { maxItems: 100 }), recordCount: Type.Integer(),
    directory: Type.Optional(text(100)), fields: Type.Optional(Type.Array(Field, { maxItems: 50 })),
    fromTypes: Type.Optional(Type.Array(text(200), { maxItems: 100 })), toTypes: Type.Optional(Type.Array(text(200), { maxItems: 100 })),
    pathPrefixes: Type.Optional(Type.Array(text(100), { maxItems: 100 })), behaviors: Definition.properties.behaviors,
    source: Type.Optional(text(500)), ontology: Type.Optional(text(64)), version: Type.Optional(text(40)),
    records: Type.Optional(Type.Array(Summary, { maxItems: 20 })), recordsTruncated: Type.Optional(Type.Boolean()),
  }), { maxItems: 100 })),
  sources: Type.Optional(Type.Array(Type.Object({ path: text(500), valid: Type.Boolean(), name: text(64), version: text(40), totalChars: Type.Integer() }), { maxItems: 100 })),
  source: Type.Optional(Type.Object({ path: text(500), raw: text(65536), totalChars: Type.Integer() })),
  chain: Type.Optional(Type.Array(text(110), { maxItems: 8 })),
  issues: Type.Optional(Type.Array(Issue, { maxItems: 100 })), totalIssues: Type.Integer(),
}, { additionalProperties: false });
export type OntologyOutput = Static<typeof OntologyOutput>;
