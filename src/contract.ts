import { Type } from "typebox";
import { defineFeatureContract } from "openclaw/plugin-sdk/feature-contract";

export const contract = defineFeatureContract({
  pluginId: "knowledge",
  operations: {
    status: {
      kind: "query",
      description: "Read Knowledge service availability and implemented capabilities. Does not read or write a vault.",
      input: Type.Object({}, { additionalProperties: false }),
      output: Type.Object({
        service: Type.Literal("knowledge"),
        phase: Type.Literal("foundation"),
        backendRevision: Type.String({ maxLength: 80 }),
        instanceId: Type.String({ maxLength: 80 }),
        startedAt: Type.String({ maxLength: 40 }),
        checkedAt: Type.String({ maxLength: 40 }),
        vault: Type.Literal("not-configured"),
        writesEnabled: Type.Literal(false),
      }, { additionalProperties: false }),
      tool: { name: "knowledge_status", label: "Knowledge status" },
    },
  },
  events: {},
});
