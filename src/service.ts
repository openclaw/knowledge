import { createKnowledgeMemoryRuntime } from "./memory-provider.js";
import { buildKnowledgeMemoryFlushPlan } from "./memory-flush.js";
import { buildKnowledgeMemoryPrompt } from "./memory-prompt.js";
import { connections } from "./connections.js";
import { DatabaseSync } from "node:sqlite";
import { keywordSearch, exactLookup } from "./retrieval.js";
import { createHash, randomUUID } from "node:crypto";
import type { FeatureHandlers, FeatureEventEmitter, FeatureInvocationContext } from "openclaw/plugin-sdk/feature-plugin";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { contract } from "./contract.js";
import { SampleVault } from "./vault.js";
import { catalogFacts } from "./catalog.js";
import { authorizeVault } from "./access.js";
import { parseVaultConfig } from "./real-vault.js";

import { inspectRecord, inspectOntology } from "./inspection.js";
import { LiveState } from "./live-state.js";
import { StorageClient } from "./storage-client.js";

const normalizeFlushTitle = (title: string) =>
  title.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();

/** Derive a stable UUIDv8 request ID for one title within one host memory flush. */
export function deriveMemoryFlushRequestId(flushId: string, title: string): string {
  const bytes = createHash("sha256")
    .update("knowledge-memory-flush\0")
    .update(flushId)
    .update("\0")
    .update(normalizeFlushTitle(title))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createKnowledgeService(api: OpenClawPluginApi, events?: FeatureEventEmitter<typeof contract>): FeatureHandlers<typeof contract> {
  const instanceId = randomUUID(), startedAt = new Date().toISOString();
  const config = parseVaultConfig(api.pluginConfig);
  // Storage runs in a worker thread; this thread authorizes and answers its
  // authority checks. The sample vault stays in-process for tests and demos.
  const storage = config ? new StorageClient(config) : undefined;
  let current = true, epoch = 0;
  const assertCurrent = () => { if (!current) throw Error("Knowledge service was reloaded; reconnect and retry the same request."); };
  let pending: Promise<void> = Promise.resolve();
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const submittedEpoch = epoch;
    const result = pending.then(() => {
      assertCurrent();
      if (submittedEpoch !== epoch) throw Error("Knowledge service was reloaded; retry the original request.");
      return operation();
    });
    // A rejected operation must not poison subsequent reads, writes or recovery.
    pending = result.then(() => undefined, () => undefined);
    return result;
  };
  if (typeof api.registerMemoryCapability === "function") {
    api.registerMemoryCapability({
      providerRuntime: createKnowledgeMemoryRuntime(storage, { enqueue, drain: () => pending, fence() {
        const openedEpoch = epoch;
        return () => { assertCurrent(); if (openedEpoch !== epoch) throw Error("Knowledge service was reloaded."); };
      } }),
      recallToolNames: ["knowledge_grep", "knowledge_lookup", "knowledge_record"],
      promptBuilder: params => config && (!params.agentId || params.agentId === config.agentId)
        ? buildKnowledgeMemoryPrompt({ ...params, availableTools: config.writesEnabled ? params.availableTools : new Set([...params.availableTools].filter(t => !["knowledge_save_page", "knowledge_correct", "knowledge_withdraw", "knowledge_recall"].includes(t))) }) : [],
      // The selected provider owns persistence; write-disabled/sample modes keep
      // suppressing Memory Core's append-only file plan with an explicit null.
      flushPlanResolver: () => config?.writesEnabled
        ? buildKnowledgeMemoryFlushPlan()
        : null,
    });
  }
  const accessFor = (context: FeatureInvocationContext, write = false) => {
    assertCurrent();
    const observedEpoch = epoch;
    const access = authorizeVault(context, config!.agentId, config!.operatorRead, write);
    return { ...access, assertCurrent() { assertCurrent(); if (observedEpoch !== epoch) throw Error("Knowledge service was reloaded; retry the original request."); access.assertCurrent(); } };
  };
  const live = config?.operatorRead ? new LiveState(config.root, () => {
    try { events?.emit("changed", {}); } catch { /* Reload/reconnect snapshots recover missed hints. */ }
  }) : undefined;
  api.registerService?.({ id: "knowledge:live-state", start() { ++epoch; current = true; live?.start(); }, stop() {
    const stopped = ++epoch; current = false; live?.stop();
    // Release the worker once queued work settles, unless the service restarted.
    void pending.finally(() => { if (epoch === stopped) storage?.close(); });
  } });
  const sample = () => { assertCurrent(); return new SampleVault(); };
  const authority = (context: FeatureInvocationContext, write = false) => {
    if (!config || !storage) throw Error("Sample vault is read-only; connect a real vault first.");
    if (write && !config.writesEnabled) throw Error("Knowledge writes are disabled.");
    return accessFor(context, write);
  };
  const handlers: FeatureHandlers<typeof contract> = {
    verify: (input, context) => storage!.call("verify", authority(context), input),
    source_check: (input, context) => storage!.call("sourceCheck", authority(context), input),
    publish_batch: async (input, context) => {
      if (context.source !== "tool") throw Error("Knowledge changes must be requested through chat and agent tools.");
      const access = authority(context, true);
      try { return await storage!.call("batch", access, input); } finally { if (access.scope.visibility === "agent-private") live?.invalidate(); }
    },
    annotate: async (input, context) => {
      if (context.source !== "tool") throw Error("Knowledge changes must be requested through chat and agent tools.");
      const access = authority(context, true);
      try { return await storage!.call("annotate", access, input); } finally { if (access.scope.visibility === "agent-private") live?.invalidate(); }
    },
    recent: async (input, context) => storage ? storage.call("recent", authority(context), input) : { items: [], upperSequence: 0, nextBefore: null },
    attach: async (input, context) => storage!.call("attach", authority(context, true), input),
    attachment: (input, context) => storage ? storage.call("attachment", accessFor(context), input) : sample().attachment(input),
    save_page: async (input, context) => {
      const access = authority(context, true);
      const flushId = context.source === "tool" ? context.tool.memoryFlush?.flushId : undefined;
      if (input.requestId === undefined && !flushId) {
        throw Error("knowledge_save_page requires requestId outside a host pre-compaction memory flush.");
      }
      const value = {
        ...input,
        requestId: input.requestId ?? deriveMemoryFlushRequestId(flushId!, input.title),
      };
      try {
        return await storage!.call("save", access, {
          value,
          actor: context.source === "tool" ? "agent" : "operator",
        });
      } finally {
        if (access.scope.visibility === "agent-private") live?.invalidate();
      }
    },
    create_claim: async (input, context) => { const access = authority(context, true); try { return await storage!.call("createClaim", access, { value: input, actor: context.source === "tool" ? "agent" : "operator" }); } finally { if (access.scope.visibility === "agent-private") live?.invalidate(); } },
    create_relationship: async (input, context) => { const access = authority(context, true); try { return await storage!.call("createRelationship", access, { value: input, actor: context.source === "tool" ? "agent" : "operator" }); } finally { if (access.scope.visibility === "agent-private") live?.invalidate(); } },
    correct: async (input, context) => {
      if (context.source !== "tool") throw Error("Knowledge changes must be requested through chat and agent tools.");
      const access = authority(context, true);
      try { return await storage!.call("correct", access, input); } finally { if (access.scope.visibility === "agent-private") live?.invalidate(); }
    },
    withdraw: async (input, context) => {
      if (context.source !== "tool") throw Error("Knowledge changes must be requested through chat and agent tools.");
      const access = authority(context, true);
      try { return await storage!.call("withdraw", access, input); } finally { if (access.scope.visibility === "agent-private") live?.invalidate(); }
    },
    recall: async (input, context) => {
      if (context.source !== "tool") throw Error("Automatic recall approval is available only through an owner-private agent tool call; browser and operator actions are not allowed.");
      if (context.tool.memoryAudience?.kind !== "owner-private") throw Error("Automatic recall approval requires the owner's private memory audience; conversation audiences are not allowed.");
      const access = authority(context, true);
      try { return await storage!.call("recall", access, input); } finally { live?.invalidate(); }
    },
    connections: async (input, context) => storage ? storage.call("connections", authority(context), input) : connections(await sample().scan(), input),
    resume: async (input, context) => { const access = authority(context, true); try { return await storage!.call("resume", access, { requestId: input.requestId }); } finally { if (access.scope.visibility === "agent-private") live?.invalidate(); } },
    revision: async (input, context) => storage!.call("revision", authority(context), { sequence: input.sequence }),
    mutation: async (input, context) => storage!.call("mutation", authority(context), input),
    history: async (input, context) => {
      if (!storage) return { entries: [], mutations: [], nextOffset: null, git: { state: "read-only", pending: 0, message: "Sample vault; no Git changes." } };
      return storage.call("history", authority(context), input);
    },
    status: async (_, context) => {
      const access = storage ? accessFor(context) : undefined;
      const scope = !access ? "sample" : access.scope.visibility === "conversation" ? `conversation:${access.scope.sessionId}` : "agent-private";
      if (scope === "agent-private") live?.ensureWatching();
      const catalog = access ? await storage!.call("catalog", access) : catalogFacts(await sample().scan());
      return {
        service: "knowledge", phase: config?.writesEnabled ? "structured-writes" : "read-only-explorer", backendRevision: "memory-provider-v2-2", instanceId, startedAt,
        checkedAt: catalog.checkedAt, vault: config?.vaultId ?? "bundled-sample", agent: config?.agentId ?? "none — synthetic sample", scope, sample: !config, writesEnabled: Boolean(config?.writesEnabled && (() => { try { authority(context, true); return true; } catch { return false; } })()),
        live: scope === "agent-private" ? live?.state ?? "stopped" : "stopped",
        snapshot: catalog.snapshot, records: catalog.records, validRecords: catalog.records,
        definitions: catalog.definitions, ontologyAvailable: catalog.ontologyAvailable, ontologyFingerprint: catalog.ontologyFingerprint, issues: catalog.issues,
      } as const;
    },
    grep: async (input, context) => {
      if (storage) return storage.call("search", authority(context), input);
      const data = await sample().scan(), db = new DatabaseSync(":memory:");
      try { return keywordSearch(db, data, input, "sample", "sample"); } finally { db.close(); }
    },
    lookup: async (input, context) => storage ? storage.call("lookup", authority(context), input) : exactLookup(await sample().scan(), input),
    records: async (input, context) => storage ? storage.call("records", accessFor(context), input) : sample().list(input),
    record: async (input, context) => storage ? storage.call("record", accessFor(context), input) : inspectRecord(sample(), input),
    ontology: async (input, context) => storage ? storage.call("ontology", accessFor(context), input) : inspectOntology(sample(), input),
    diagnostics: async (_, context) => {
      const data = storage ? undefined : await sample().scan();
      return storage ? storage.call("diagnostics", accessFor(context)) : { issues: data!.issues.slice(0, 1000), total: data!.issues.length, truncated: data!.issues.length > 1000, checkedAt: data!.checkedAt };
    },
  };
  // RealVault fences an operation's manifest/checkpoint snapshot. A sibling
  // publication advances that snapshot, so reads as well as writes must share
  // this lane. Otherwise ordinary parallel tool/UI calls look like an external
  // vault replacement. Keep the filesystem and revision fences intact.
  if (!storage) return handlers;
  const serialize = <Input, Output>(handler: (input: Input, context: FeatureInvocationContext) => Output | Promise<Output>) =>
    (input: Input, context: FeatureInvocationContext): Promise<Output> => enqueue(async () => handler(input, context));
  return Object.fromEntries(Object.entries(handlers).map(([name, handler]) =>
    [name, serialize(handler as (input: never, context: FeatureInvocationContext) => unknown)])) as FeatureHandlers<typeof contract>;
}
