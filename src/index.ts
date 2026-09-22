import { randomUUID } from "node:crypto";
import { defineFeaturePlugin } from "openclaw/plugin-sdk/feature-plugin";
import { contract } from "./contract.js";
import { SampleVault } from "./vault.js";

export default defineFeaturePlugin({
  contract, name: "Knowledge", description: "Evidence-backed knowledge, inspectable in OpenClaw.",
  setup() {
    const instanceId = randomUUID(), startedAt = new Date().toISOString(), vault = new SampleVault();
    return {
      status: async () => {
        const data = await vault.scan();
        return {
          service: "knowledge", phase: "read-only-explorer", backendRevision: "explorer-1", instanceId, startedAt,
          checkedAt: data.checkedAt, vault: "bundled-sample", agent: "none — synthetic sample", writesEnabled: false,
          records: data.records.length, validRecords: data.records.filter(r => r.valid).length,
          schemas: data.schemas.filter(s => s.valid).length, issues: data.issues.length,
        } as const;
      },
      records: input => vault.list(input),
      record: input => vault.detail(input.id),
      schemas: async () => {
        const data = await vault.scan();
        return { schemas: data.schemas.map(s => ({
          path: s.path, raw: s.raw, valid: s.valid, name: s.definition?.name ?? "", version: s.definition?.version ?? "",
          label: s.definition?.label ?? "Invalid definition", kind: s.definition?.kind ?? "", directory: s.definition?.directory ?? "",
          affectedRecords: data.records.filter(r => r.type === (s.definition?.name ?? s.path.split("/").pop()!.replace(/\.ya?ml$/, ""))).length,
          issues: data.issues.filter(i => i.path === s.path).slice(0, 1000),
        })) };
      },
      diagnostics: async () => { const data = await vault.scan(); return { issues: data.issues.slice(0, 1000), total: data.issues.length, truncated: data.issues.length > 1000, checkedAt: data.checkedAt }; },
    };
  },
});
