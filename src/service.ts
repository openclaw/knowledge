import { createHash, randomUUID } from "node:crypto";
import { Check } from "typebox/value";
import type { FeatureHandlers, FeatureEventEmitter, FeatureInvocationContext } from "openclaw/plugin-sdk/feature-plugin";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createKnowledgeMemoryRuntime } from "./memory-provider.js";
import { buildKnowledgeMemoryPrompt } from "./memory-prompt.js";
import { buildKnowledgeMemoryFlushPlan } from "./memory-flush.js";
import { emptyChronicle } from "./chronicle.js";
import { SinceInput, LastSeenInput } from "./chronicle-contract.js";
import { contract } from "./contract.js";
import { featurePrincipal, type VaultAccess } from "./access.js";
import { parsePolicy } from "./stores-config.js";
import { Stores } from "./stores.js";
import { createStoreOperations } from "./store-assignments.js";
import type { StoreRuntime } from "./store-runtime.js";
import type { StoreState } from "./stores-contract.js";
import type { StorageOperations } from "./storage-host.js";

type Handlers = FeatureHandlers<typeof contract>;
type StoreHandlers = Omit<Handlers, "stores_snapshot" | "stores_change" | "stores_change_status" | "agent_query" | "agent_action">;
const WRITE_TOOLS = ["knowledge_save_page", "knowledge_correct", "knowledge_withdraw", "knowledge_recall"];
const chatOnly = () => Error("Knowledge changes must be requested through chat and agent tools.");
const operatorOnly = () => Error("Selecting an agent's store is an operator inspection; it is not available to agent tools.");

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

export function createKnowledgeService(api: OpenClawPluginApi, events?: FeatureEventEmitter<typeof contract>): Handlers {
  const instanceId = randomUUID(), startedAt = new Date().toISOString();
  const policy = parsePolicy(api.pluginConfig);
  const stores = new Stores(api, policy, () => {
    try { events?.emit("changed", {}); } catch { /* Reload/reconnect snapshots recover missed hints. */ }
  });
  if (typeof api.registerMemoryCapability === "function") {
    api.registerMemoryCapability({
      providerRuntime: createKnowledgeMemoryRuntime(stores),
      recallToolNames: ["knowledge_grep", "knowledge_lookup", "knowledge_record"],
      // Every agent has an effective store, so every agent gets the guidance.
      promptBuilder: params => buildKnowledgeMemoryPrompt({ ...params, availableTools: policy.writesEnabled ? params.availableTools : new Set([...params.availableTools].filter(t => !WRITE_TOOLS.includes(t))) }),
      // The selected provider owns persistence through the host-completed resolver;
      // write-disabled installs suppress Memory Core's append-only file plan with an explicit null.
      providerFlushPlanResolver: () => policy.writesEnabled ? buildKnowledgeMemoryFlushPlan() : null,
    });
  }
  api.registerService?.({ id: "knowledge:live-state", start() { stores.start(); }, stop() { stores.stop(); } });

  /** Handlers bound to one operator viewing selection. Tools always resolve
   * their store from the host audience; `agent` only applies to operators. */
  const storeHandlers = (agent?: string): StoreHandlers => {
    // Resolve, then run inside the store's lane. Agent tools may create a
    // never-provisioned store; operator inspection never does.
    const use = async <T>(context: FeatureInvocationContext, write: boolean, work: (runtime: StoreRuntime, access: VaultAccess) => Promise<T>, whenEmpty?: () => T): Promise<T> => {
      if (write && !policy.writesEnabled) throw Error("Knowledge writes are disabled.");
      const opened = await stores.open(featurePrincipal(context, policy.operatorRead, write, agent ?? stores.defaultAgent()), { provision: context.source === "tool" }, stores.incarnation);
      if (opened.kind !== "ready") {
        if (opened.kind === "unprovisioned" && whenEmpty) return whenEmpty();
        throw Error(opened.message);
      }
      const access = { ...opened.access, ...(context.source === "tool" && context.tool.sessionKey && context.tool.sessionId && context.toolCallId ? {
        activity: { sessionKey: context.tool.sessionKey, sessionId: context.tool.sessionId, toolCallId: context.toolCallId, operation: "knowledge", at: new Date().toISOString() },
      } : {}) };
      const result = await opened.runtime.enqueue(access.assertCurrent, () => work(opened.runtime, access));
      if (write && opened.access.scope.visibility === "private") opened.runtime.live.invalidate();
      return result;
    };
    // A plain storage call: one worker operation in the resolved store.
    const call = <Op extends keyof StorageOperations>(op: Op, write = false, whenEmpty?: () => Awaited<ReturnType<StorageOperations[Op]>>) =>
      (input: unknown, context: FeatureInvocationContext) => use(context, write, (runtime, access) =>
        (runtime.client.call as (op: Op, access: VaultAccess, input?: unknown) => Promise<Awaited<ReturnType<StorageOperations[Op]>>>)(op, access, input), whenEmpty);
    // Agent-only changes reject (never throw synchronously) for other callers.
    const agentChange = <Op extends keyof StorageOperations>(op: Op) => (input: unknown, context: FeatureInvocationContext) =>
      context.source !== "tool" ? Promise.reject(chatOnly()) : call(op, true)(input, context);
    const authored = <Op extends "save" | "createClaim" | "createRelationship">(op: Op) => (input: unknown, context: FeatureInvocationContext) =>
      use(context, true, (runtime, access) => (runtime.client.call as (op: Op, access: VaultAccess, input: unknown) => Promise<Awaited<ReturnType<StorageOperations[Op]>>>)(op, access, { value: input, actor: context.source === "tool" ? "agent" : "operator" }));
    const now = () => new Date().toISOString();
    return {
      session_activity: (input, context) => context.source !== "session-action" ? Promise.reject(operatorOnly()) : call("sessionActivity", false, () => ({ upper: 0, nextBefore: null, items: [] }))(input, context),
      verify: call("verify"),
      source_check: call("sourceCheck"),
      publish_batch: agentChange("batch"),
      annotate: agentChange("annotate"),
      timeline: (input, context) => call("timeline", false, () => emptyChronicle(input))(input, context),
      chronicle_day: (input, context) => call("chronicleDay", false, () => {
        const { date: _date, timezone: _zone, week: _week, ...filters } = input;
        return emptyChronicle(filters, input);
      })(input, context),
      chronicle_since: (input, context) => call("chronicleSince", false, () => {
        if (!Check(SinceInput, input)) throw Error("Invalid since query input.");
        return emptyChronicle(input);
      })(input, context),
      chronicle_last_seen: (input, context) => call("chronicleLastSeen", false, () => {
        if (!Check(LastSeenInput, input)) throw Error("Invalid last-seen input.");
        const asOf = input.asOf ?? now(), result = emptyChronicle({ entity: input.entity, until: asOf });
        return { entity: input.entity, asOf, last: null, snapshot: result.snapshot,
          message: "This store has not been provisioned; no dated context is available. Absence is not proof of no interaction." };
      })(input, context),
      recent: call("recent", false, () => ({ items: [], upperSequence: 0, nextBefore: null })),
      attach: call("attach", true),
      attachment: call("attachment"),
      // Inside a host pre-compaction flush, a missing requestId is derived from
      // the flush and title so the flush's retries replay instead of duplicating.
      save_page: (input, context) => {
        const flushId = context.source === "tool" ? context.tool.memoryFlush?.flushId : undefined;
        if (input.requestId === undefined && !flushId) return Promise.reject(Error("knowledge_save_page requires requestId outside a host pre-compaction memory flush."));
        return authored("save")({ ...input, requestId: input.requestId ?? deriveMemoryFlushRequestId(flushId!, input.title) }, context);
      },
      create_claim: authored("createClaim"),
      create_relationship: authored("createRelationship"),
      correct: agentChange("correct"),
      withdraw: agentChange("withdraw"),
      recall: (input, context) => {
        if (context.source !== "tool") return Promise.reject(Error("Automatic recall approval is available only through an owner-private agent tool call; browser and operator actions are not allowed."));
        if (context.tool.memoryAudience?.kind !== "owner-private") return Promise.reject(Error("Automatic recall approval requires the owner's private memory audience; conversation audiences are not allowed."));
        return use(context, true, (runtime, access) => runtime.client.call("recall", access, input));
      },
      connections: call("connections"),
      resume: (input, context) => use(context, true, (runtime, access) => runtime.client.call("resume", access, { requestId: input.requestId })),
      revision: (input, context) => use(context, false, (runtime, access) => runtime.client.call("revision", access, { sequence: input.sequence })),
      mutation: call("mutation"),
      history: call("history", false, () => ({ entries: [], mutations: [], nextOffset: null, git: { state: "idle" as const, pending: 0, message: "Nothing saved here yet." } })),
      status: async (_, context) => {
        const opened = await stores.open(featurePrincipal(context, policy.operatorRead, false, agent ?? stores.defaultAgent()), { provision: false }, stores.incarnation);
        const base = { service: "knowledge" as const, phase: policy.writesEnabled ? "structured-writes" as const : "read-only-explorer" as const, backendRevision: "memory-provider-v2-2+stores-v1+chronicle-v1", instanceId, startedAt };
        const notReady = (agentId: string, store: Exclude<StoreState, "ready">, message: string) => ({ ...base, checkedAt: now(), vault: "", agent: agentId, store, scope: "private", writesEnabled: false, live: "stopped" as const,
          records: 0, validRecords: 0, definitions: 0, ontologyAvailable: false, ontologyFingerprint: "", issues: 0, message: message.slice(0, 300) });
        if (opened.kind !== "ready") return notReady(opened.agentId, opened.kind, opened.message);
        const { runtime, access } = opened;
        const scope = access.scope.visibility === "conversation" ? `conversation:${access.scope.sessionId}` : "private";
        let catalog;
        try { catalog = await runtime.enqueue(access.assertCurrent, () => runtime.client.call("catalog", access)); }
        catch (e) {
          // A provisioned store that fails its identity checks is reported, never replaced.
          if (!/identity or storage is unavailable/.test((e as Error).message)) throw e;
          return notReady(access.agentId, "unavailable", `This store couldn't be opened. ${(e as Error).message}`);
        }
        if (scope === "private") runtime.live.ensureWatching();
        const canWrite = policy.writesEnabled && (context.source === "tool" || (context.source === "session-action" && Boolean(context.action.client?.scopes.some((s: string) => s === "operator.write" || s === "operator.admin"))));
        return {
          ...base, checkedAt: catalog.checkedAt, vault: runtime.vaultId, agent: access.agentId, store: "ready" as const, scope, writesEnabled: canWrite,
          live: scope === "private" ? runtime.live.state : "stopped",
          snapshot: catalog.snapshot, records: catalog.records, validRecords: catalog.records,
          definitions: catalog.definitions, ontologyAvailable: catalog.ontologyAvailable, ontologyFingerprint: catalog.ontologyFingerprint, issues: catalog.issues,
        };
      },
      grep: call("search"),
      lookup: call("lookup"),
      records: call("records", false, () => ({ facets: { kinds: {}, origins: {} }, records: [], total: 0, offset: 0, nextOffset: null, checkedAt: now() })),
      record: call("record"),
      ontology: call("ontology"),
      diagnostics: call("diagnostics", false, () => ({ issues: [], total: 0, truncated: false, checkedAt: now() })),
    } as StoreHandlers;
  };

  const defaults = storeHandlers();
  // Operator-only proxy: run one ordinary operation against a selected agent's
  // effective store. Validates the inner input and output with the operation's
  // own schemas, and never serves agent tools.
  const proxy = (kind: "query" | "action") => async (input: { agent: string; operation: string; input: unknown }, context: FeatureInvocationContext) => {
    if (context.source !== "session-action") throw operatorOnly();
    const operation = contract.operations[input.operation as keyof StoreHandlers];
    if (!operation || !(input.operation in defaults) || operation.kind !== kind) throw Error(`Unknown ${kind} operation: ${input.operation}.`);
    await stores.ensure();
    if (!stores.agents().includes(input.agent)) throw Error("Unknown agent.");
    if (!Check(operation.input, input.input)) throw Error(`Invalid input for ${input.operation}.`);
    const handler = storeHandlers(input.agent)[input.operation as keyof StoreHandlers] as (input: unknown, context: FeatureInvocationContext) => Promise<unknown>;
    const output = await handler(input.input, context);
    if (!Check(operation.output, output)) throw Error(`Invalid output from ${input.operation}.`);
    return output;
  };
  return { ...defaults, ...createStoreOperations(stores), agent_query: proxy("query"), agent_action: proxy("action") } as Handlers;
}
