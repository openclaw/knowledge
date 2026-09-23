import { randomUUID } from "node:crypto";
import type { FeatureHandlers, FeatureEventEmitter, FeatureInvocationContext } from "openclaw/plugin-sdk/feature-plugin";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { contract } from "./contract.js";
import { SampleVault } from "./vault.js";
import { authorizeVault } from "./access.js";
import { parseVaultConfig } from "./real-vault.js";

import { inspectRecord, inspectOntology } from "./inspection.js";
import { LiveState } from "./live-state.js";
import { KnowledgeStorage } from "./storage.js";

export function createKnowledgeService(api: OpenClawPluginApi, events?: FeatureEventEmitter<typeof contract>): FeatureHandlers<typeof contract> {
  const instanceId = randomUUID(), startedAt = new Date().toISOString();
  const config = parseVaultConfig(api.pluginConfig);
  const storage = config ? new KnowledgeStorage(config) : undefined;
  let current = true, epoch = 0;
  const assertCurrent = () => { if (!current) throw Error("Knowledge service was reloaded; reconnect and retry the same request."); };
  const accessFor = (context: FeatureInvocationContext, write = false) => {
    assertCurrent();
    const observedEpoch = epoch;
    const access = authorizeVault(context, config!.agentId, config!.operatorRead, write);
    return { ...access, assertCurrent() { assertCurrent(); if (observedEpoch !== epoch) throw Error("Knowledge service was reloaded; retry the original request."); access.assertCurrent(); } };
  };
  const live = config?.operatorRead ? new LiveState(config.root, () => {
    try { events?.emit("changed", {}); } catch { /* Reload/reconnect snapshots recover missed hints. */ }
  }) : undefined;
  api.registerService?.({ id: "knowledge:live-state", start() { ++epoch; current = true; live?.start(); }, stop() { ++epoch; current = false; live?.stop(); } });
  const run = async <T>(context: FeatureInvocationContext, operation: (vault: SampleVault, scope: string) => Promise<T>): Promise<T> => {
    assertCurrent();
    if (!storage || !config) return operation(new SampleVault(), "sample");
    const access = accessFor(context);
    return storage.run(access, vault => operation(vault, access.scope.visibility === "conversation" ? `conversation:${access.scope.sessionId}` : "agent-private"));
  };
  const authority = (context: FeatureInvocationContext, write = false) => {
    if (!config || !storage) throw Error("Sample vault is read-only; connect a real vault first.");
    if (write && !config.writesEnabled) throw Error("Knowledge writes are disabled.");
    return accessFor(context, write);
  };
  return {
    save_page: async (input, context) => { const access = authority(context, true); try { return await storage!.save(input, access, context.source === "tool" ? "agent" : "operator"); } finally { if (access.scope.visibility === "agent-private") live?.invalidate(); } },
    resume: async (input, context) => { const access = authority(context, true); try { return storage!.resume(access, input.requestId); } finally { if (access.scope.visibility === "agent-private") live?.invalidate(); } },
    revision: async (input, context) => { const access = authority(context); return storage!.revision(access, input.sequence); },
    mutation: async (input, context) => { const access = authority(context); return storage!.mutation(access, input.requestId); },
    history: async (input, context) => {
      if (!storage) return { entries: [], mutations: [], nextOffset: null, git: { state: "read-only", pending: 0, message: "Sample vault; no Git changes." } };
      const access = authority(context);
      await storage.initialize(access);
      return storage.history(access, input);
    },
    status: (_, context) => run(context, async (vault, scope) => {
      if (scope === "agent-private") live?.ensureWatching();
      const data = await vault.scan();
      return {
        service: "knowledge", phase: config?.writesEnabled ? "page-editor" : "read-only-explorer", backendRevision: "live-state-1", instanceId, startedAt,
        checkedAt: data.checkedAt, vault: config?.vaultId ?? "bundled-sample", agent: config?.agentId ?? "none — synthetic sample", scope, sample: !config, writesEnabled: Boolean(config?.writesEnabled && (() => { try { authority(context, true); return true; } catch { return false; } })()),
        live: scope === "agent-private" ? live?.state ?? "stopped" : "stopped",
        records: data.records.length, validRecords: data.records.filter(r => r.valid).length,
        definitions: data.ontology?.definitions.length ?? 0, ontologyAvailable: Boolean(data.ontology), ontologyFingerprint: data.ontology?.fingerprint ?? "", issues: data.issues.length,
      } as const;
    }),
    records: (input, context) => run(context, vault => vault.list(input)),
    record: (input, context) => run(context, vault => inspectRecord(vault, input)),
    ontology: (input, context) => run(context, vault => inspectOntology(vault, input)),
    diagnostics: (_, context) => run(context, async vault => {
      const data = await vault.scan();
      return { issues: data.issues.slice(0, 1000), total: data.issues.length, truncated: data.issues.length > 1000, checkedAt: data.checkedAt };
    }),
  };
}
