import type { FeatureInvocationContext } from "openclaw/plugin-sdk/feature-plugin";
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
    if (tool.agentId !== agentId || !tool.sessionKey || !tool.sessionId || !/^[a-f0-9-]{36}$/.test(tool.sessionId)) throw denied();
    const entry = context.api.runtime.agent.session.getSessionEntry({ agentId, sessionKey: tool.sessionKey, readConsistency: "latest" });
    if (!entry || entry.sessionId !== tool.sessionId) throw denied();
    // Never infer direct-chat authority from ownership alone: an owner can speak
    // in a group. Missing chat type is not evidence that this is private.
    if (entry.chatType === "direct" && tool.senderIsOwner === true) return { visibility: "agent-private", agentId };
    if (!["direct", "group", "channel"].includes(entry.chatType ?? "")) throw denied();
    return { visibility: "conversation", agentId, sessionId: tool.sessionId };
  };
  const scope = resolve();
  return { scope, assertCurrent() { if (JSON.stringify(resolve()) !== JSON.stringify(scope)) throw denied(); } };
}
