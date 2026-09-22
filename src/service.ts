import { randomUUID } from "node:crypto";
import type { FeatureHandlers, FeatureInvocationContext } from "openclaw/plugin-sdk/feature-plugin";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { contract } from "./contract.js";
import { SampleVault } from "./vault.js";
import { SqliteIdentityStore } from "./identity-store.js";
import { authorizeVault } from "./access.js";
import { RealVault, parseVaultConfig } from "./real-vault.js";

export function createKnowledgeService(api: OpenClawPluginApi): FeatureHandlers<typeof contract> {
  const instanceId = randomUUID(), startedAt = new Date().toISOString();
  const config = parseVaultConfig(api.pluginConfig);
  const real = config ? new RealVault(config, new SqliteIdentityStore(config.statePath)) : undefined;
  const run = async <T>(context: FeatureInvocationContext, operation: (vault: SampleVault, scope: string) => Promise<T>): Promise<T> => {
    if (!real || !config) return operation(new SampleVault(), "sample");
    const access = authorizeVault(context, config.agentId, config.operatorRead);
    return real.run(access, vault => operation(vault, access.scope.visibility === "conversation" ? `conversation:${access.scope.sessionId}` : "agent-private"));
  };
  return {
    status: (_, context) => run(context, async (vault, scope) => {
      const data = await vault.scan();
      return {
        service: "knowledge", phase: "read-only-explorer", backendRevision: "real-vault-1", instanceId, startedAt,
        checkedAt: data.checkedAt, vault: config?.vaultId ?? "bundled-sample", agent: config?.agentId ?? "none — synthetic sample", scope, sample: !config, writesEnabled: false,
        records: data.records.length, validRecords: data.records.filter(r => r.valid).length,
        definitions: data.ontology?.definitions.length ?? 0, ontologyAvailable: Boolean(data.ontology), ontologyFingerprint: data.ontology?.fingerprint ?? "", issues: data.issues.length,
      } as const;
    }),
    records: (input, context) => run(context, vault => vault.list(input)),
    record: (input, context) => run(context, vault => vault.detail(input.id)),
    ontology: (_, context) => run(context, vault => vault.inspectOntology()),
    diagnostics: (_, context) => run(context, async vault => {
      const data = await vault.scan();
      return { issues: data.issues.slice(0, 1000), total: data.issues.length, truncated: data.issues.length > 1000, checkedAt: data.checkedAt };
    }),
  };
}
