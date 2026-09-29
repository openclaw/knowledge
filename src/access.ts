import type { FeatureInvocationContext } from "openclaw/plugin-sdk/feature-plugin";
import type { MemoryCallerContext } from "./memory-provider-types.js";
import type { Scope } from "./model.js";

const denied = () => new Error("Knowledge access unavailable: trusted agent/session authority is required.");
export type VaultAccess = { scope: Exclude<Scope, { visibility: "sample" }>; assertCurrent: () => void };
type Resolution = { scope: VaultAccess["scope"] };
type MemoryAudience = NonNullable<Extract<MemoryCallerContext["authority"], { kind: "session" }>["audience"]>;

/** Provider access distinguishes partition reads from host-only readiness checks. */
export type MemoryAccess = VaultAccess & { healthOnly: boolean; ownerPrivate: boolean; assertContentAccess: () => void };

function bindAccess(resolve: () => Resolution): VaultAccess {
  const initial = resolve(), identity = JSON.stringify(initial);
  return { scope: initial.scope, assertCurrent() { if (JSON.stringify(resolve()) !== identity) throw denied(); } };
}

// Fence both the partition and the health-only restriction for the lease lifetime.
function bindMemoryAccess(resolve: () => Resolution & { healthOnly: boolean; ownerPrivate: boolean }): MemoryAccess {
  const initial = resolve(), identity = JSON.stringify(initial);
  return { ...initial, assertCurrent() { if (JSON.stringify(resolve()) !== identity) throw denied(); },
    assertContentAccess() { if (initial.healthOnly) throw denied(); } };
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
    tool.assertMemoryAudienceCurrent?.();
    return audienceScope(tool.memoryAudience, agentId);
  });
}

function audienceScope(
  audience: MemoryAudience | undefined,
  agentId: string,
): Resolution {
  if (!audience || audience.agentId !== agentId) throw denied();
  if (audience.kind === "owner-private") return { scope: { visibility: "agent-private", agentId } };
  return { scope: { visibility: "conversation", agentId, sessionId: audience.sessionId } };
}

/** Provider runtime access is host-issued, not a fabricated feature/tool invocation. */
export function authorizeMemoryAccess(context: MemoryCallerContext,
  agentId: string, requestedAgent: string, operatorRead: boolean,
  purpose?: "default" | "status" | "cli"): MemoryAccess {
  return bindMemoryAccess(() => {
    if (typeof context.assertCurrent !== "function" || requestedAgent !== agentId) throw denied();
    context.signal?.throwIfAborted();
    context.assertCurrent();
    const caller = context.authority;
    if (caller.kind === "host") {
      if (purpose !== "status") throw denied();
      // The scope is internal to validation; this lease cannot release its content.
      return { scope: { visibility: "agent-private", agentId }, healthOnly: true, ownerPrivate: false };
    }
    if (caller.kind === "operator") {
      if (!operatorRead || !caller.connId || !caller.scopes.some(s => ["operator.read", "operator.write", "operator.admin"].includes(s))) throw denied();
      return { scope: { visibility: "agent-private", agentId }, healthOnly: false, ownerPrivate: false };
    }
    // Background host calls are not session delegation. Session identity is a
    // host-minted audience; providers consume it without reconstructing lineage.
    if (caller.kind !== "session" || caller.sandboxed) throw denied();
    return { ...audienceScope(caller.audience, agentId), healthOnly: false, ownerPrivate: caller.audience?.kind === "owner-private" };
  });
}
