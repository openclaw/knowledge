import { parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import type { FeatureInvocationContext } from "openclaw/plugin-sdk/feature-plugin";
import type { MemoryCallerContextV2 } from "openclaw/plugin-sdk/memory-host-search";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { Scope } from "./model.js";

const denied = () => new Error("Knowledge access unavailable: trusted agent/session authority is required.");
export type VaultAccess = { scope: Exclude<Scope, { visibility: "sample" }>; assertCurrent: () => void };

/** No payload field participates in authorization. Re-evaluate before releasing results. */
export function authorizeVault(context: FeatureInvocationContext, agentId: string, operatorRead: boolean, write = false): VaultAccess {
  const resolve = (): Exclude<Scope, { visibility: "sample" }> => {
    if (context.source === "session-action") {
      const { client, agentId: selectedAgent, sessionKey } = context.action;
      if (!operatorRead || !client?.connId || !client.scopes.some(s => ["operator.read", "operator.write", "operator.admin"].includes(s))) throw denied();
      if (write && !client.scopes.some(s => ["operator.write", "operator.admin"].includes(s))) throw denied();
      // This first browser surface is the configured agent's private vault, not a
      // conversation impersonation surface. A supplied target cannot expand it.
      if (sessionKey || (selectedAgent && selectedAgent !== agentId)) throw denied();
      return { visibility: "agent-private", agentId };
    }
    if (context.source !== "tool") throw denied();
    const tool = context.tool;
    context.signal?.throwIfAborted();
    if (typeof tool.assertInvocationCurrent !== "function") throw denied();
    tool.assertInvocationCurrent();
    return sessionScope(context.api, agentId, tool);
  };
  const scope = resolve();
  return { scope, assertCurrent() { if (JSON.stringify(resolve()) !== JSON.stringify(scope)) throw denied(); } };
}

function sessionScope(api: OpenClawPluginApi, agentId: string, caller: {
  agentId?: string; sessionKey?: string; sessionId?: string; senderIsOwner?: boolean;
}): VaultAccess["scope"] {
  if (caller.agentId !== agentId || !caller.sessionKey || !caller.sessionId || !/^[a-f0-9-]{36}$/.test(caller.sessionId)) throw denied();
  const entry = api.runtime.agent.session.getSessionEntry({ agentId, sessionKey: caller.sessionKey, readConsistency: "latest" });
  if (!entry || entry.sessionId !== caller.sessionId) throw denied();
  // Live host session metadata confirms incarnation/chat type; it never supplies
  // missing caller ownership or an invocation grant.
  if (entry.chatType === "direct" && caller.senderIsOwner === true) return { visibility: "agent-private", agentId };
  if (!["direct", "group", "channel"].includes(entry.chatType ?? "")) throw denied();
  return { visibility: "conversation", agentId, sessionId: caller.sessionId };
}

/** V2 is a host-issued read capability, not a fabricated feature/tool invocation. */
export function authorizeMemoryAccess(api: OpenClawPluginApi, context: MemoryCallerContextV2,
  agentId: string, requestedAgent: string, operatorRead: boolean): VaultAccess {
  const resolve = (): VaultAccess["scope"] => {
    if (context.version !== 2 || typeof context.assertCurrent !== "function" || requestedAgent !== agentId) throw denied();
    context.signal?.throwIfAborted();
    context.assertCurrent();
    const caller = context.authority;
    if (caller.kind === "operator") {
      if (!operatorRead || !caller.connId || !caller.scopes.some(s => ["operator.read", "operator.write", "operator.admin"].includes(s))) throw denied();
      return { visibility: "agent-private", agentId };
    }
    // No source-bound delegation is defined for host/background callers. A
    // sandboxed caller cannot acquire unrestricted local-vault access here.
    if (caller.kind !== "session" || caller.sandboxed || parseAgentSessionKey(caller.sessionKey)?.agentId !== agentId) throw denied();
    return sessionScope(api, agentId, { ...caller, agentId: requestedAgent });
  };
  const scope = resolve();
  return { scope, assertCurrent() { if (JSON.stringify(resolve()) !== JSON.stringify(scope)) throw denied(); } };
}
