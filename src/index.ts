import { randomUUID } from "node:crypto";
import { defineFeaturePlugin } from "openclaw/plugin-sdk/feature-plugin";
import { contract } from "./contract.js";

export default defineFeaturePlugin({
  contract,
  name: "Knowledge",
  description: "Evidence-backed knowledge, inspectable in OpenClaw.",
  setup() {
    const instanceId = randomUUID();
    const startedAt = new Date().toISOString();
    return {
      status: () => ({
        service: "knowledge",
        phase: "foundation",
        backendRevision: "foundation-2",
        instanceId,
        startedAt,
        checkedAt: new Date().toISOString(),
        vault: "not-configured",
        writesEnabled: false,
      } as const),
    };
  },
});
