import { parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import type { FeatureInvocationContext } from "openclaw/plugin-sdk/feature-plugin";
import type { MemoryCallerContextV2 } from "openclaw/plugin-sdk/memory-host-search";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { Scope } from "./model.js";

const denied = () => new Error("Knowledge access unavailable: trusted agent/session authority is required.");
export type VaultAccess = { scope: Exclude<Scope, { visibility: "sample" }>; assertCurrent: () => void };
type Resolution = { scope: VaultAccess["scope"]; lineage?: unknown[] };

function bindAccess(resolve: () => Resolution): VaultAccess {
  const initial = resolve(), identity = JSON.stringify(initial);
  return { scope: initial.scope, assertCurrent() { if (JSON.stringify(resolve()) !== identity) throw denied(); } };
}

/** No payload field participates in authorization. Re-evaluate before releasing results. */
export function authorizeVault(context: FeatureInvocationContext, agentId: string, operatorRead: boolean, write = false): VaultAccess {
  return bindAccess(() => {
    if (context.source === "session-action") {
      const { client, agentId: selectedAgent, sessionKey } = context.action;
      if (!operatorRead || !client?.connId || !client.scopes.some(s => ["operator.read", "operator.write", "operator.admin"].includes(s))) throw denied();
      if (write && !client.scopes.some(s => ["operator.write", "operator.admin"].includes(s))) throw denied();
      // This first browser surface is the configured agent's private vault, not a
      // conversation impersonation surface. A supplied target cannot expand it.
      if (sessionKey || (selectedAgent && selectedAgent !== agentId)) throw denied();
      return { scope: { visibility: "agent-private", agentId } };
    }
    if (context.source !== "tool") throw denied();
    const tool = context.tool;
    context.signal?.throwIfAborted();
    if (typeof tool.assertInvocationCurrent !== "function") throw denied();
    tool.assertInvocationCurrent();
    return sessionScope(context.api, agentId, tool);
  });
}

function sessionScope(api: OpenClawPluginApi, agentId: string, caller: {
  agentId?: string; sessionKey?: string; sessionId?: string; senderIsOwner?: boolean;
}): Resolution {
  if (caller.agentId !== agentId) throw denied();
  let { sessionKey, sessionId, senderIsOwner } = caller;
  let parentLifecycleRevision: string | undefined;
  const seen = new Set<string>(), lineage: unknown[] = [];
  for (let depth = 0; depth < 64; depth++) {
    if (!sessionKey || parseAgentSessionKey(sessionKey)?.agentId !== agentId || !sessionId || !/^[a-f0-9-]{36}$/.test(sessionId) || seen.has(sessionKey)) throw denied();
    seen.add(sessionKey);
    const entry = api.runtime.agent.session.getSessionEntry({ agentId, sessionKey, readConsistency: "latest" });
    if (!entry || entry.sessionId !== sessionId || (depth > 0 && entry.lifecycleRevision !== parentLifecycleRevision)) throw denied();
    lineage.push([sessionKey, sessionId, entry.lifecycleRevision, entry.chatType, entry.spawnedBy, entry.parentSessionKey, entry.parentSessionId, entry.parentSessionLifecycleRevision, entry.spawnedBySenderIsOwner]);
    if (entry.spawnedBy !== undefined) {
      // Spawn captures the parent's invocation owner bit and exact incarnation.
      // The worker's launch identity and any copied chat metadata are not grants.
      if (!entry.spawnedBy || entry.parentSessionKey !== entry.spawnedBy || !entry.parentSessionId || typeof entry.spawnedBySenderIsOwner !== "boolean") throw denied();
      sessionKey = entry.spawnedBy;
      sessionId = entry.parentSessionId;
      parentLifecycleRevision = entry.parentSessionLifecycleRevision;
      senderIsOwner = entry.spawnedBySenderIsOwner;
      continue;
    }
    if (entry.chatType === "direct" && senderIsOwner === true) return { scope: { visibility: "agent-private", agentId }, lineage };
    if (!["direct", "group", "channel"].includes(entry.chatType ?? "")) throw denied();
    return { scope: { visibility: "conversation", agentId, sessionId }, lineage };
  }
  throw denied();
}

/** V2 is a host-issued read capability, not a fabricated feature/tool invocation. */
export function authorizeMemoryAccess(api: OpenClawPluginApi, context: MemoryCallerContextV2,
  agentId: string, requestedAgent: string, operatorRead: boolean): VaultAccess {
  return bindAccess(() => {
    if (context.version !== 2 || typeof context.assertCurrent !== "function" || requestedAgent !== agentId) throw denied();
    context.signal?.throwIfAborted();
    context.assertCurrent();
    const caller = context.authority;
    if (caller.kind === "operator") {
      if (!operatorRead || !caller.connId || !caller.scopes.some(s => ["operator.read", "operator.write", "operator.admin"].includes(s))) throw denied();
      return { scope: { visibility: "agent-private", agentId } };
    }
    // Background host calls are not session delegation. Keep the shared-memory
    // sandbox boundary; native children use the same lineage resolver as tools.
    if (caller.kind !== "session" || caller.sandboxed || parseAgentSessionKey(caller.sessionKey)?.agentId !== agentId) throw denied();
    return sessionScope(api, agentId, { ...caller, agentId: requestedAgent });
  });
}
