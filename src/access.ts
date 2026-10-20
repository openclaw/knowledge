import type { FeatureInvocationContext } from "openclaw/plugin-sdk/feature-plugin";
import type { MemoryCallerContext } from "./memory-provider-types.js";
import type { Scope } from "./model.js";

const denied = () => new Error("Knowledge access unavailable: trusted agent/session authority is required.");
// The host mints no audience when a session's lineage no longer verifies; the
// common case is a subagent whose parent was reset, which only a respawn repairs.
const noAudience = () => new Error("Knowledge access unavailable: this session has no host memory authority. A subagent loses it when its parent session is reset or deleted after the spawn; respawn it from the current parent session. The Gateway log names the exact reason.");
/** A store partition: the store's private knowledge or one trusted conversation. */
export type Partition = Exclude<Scope, { visibility: "sample" }>;
/** Who is asking, and for which partition of their effective store. */
export type Principal = { agentId: string; scope: Partition };
/** Resolved, live-checked access. `agentId` is the effective agent (reader and
 * writer); the store is chosen by membership, never by the caller. */
export type VaultAccess = Principal & { assertCurrent: () => void; activity?: import("./session-activity.js").ActivityOrigin };
type MemoryAudience = NonNullable<Extract<MemoryCallerContext["authority"], { kind: "session" }>["audience"]>;
/** Provider principals also say whether the lease may release content at all
 * (host readiness checks may not) and whether it is the owner's private audience. */
export type MemoryPrincipal = Principal & { healthOnly: boolean; ownerPrivate: boolean };
const OPERATOR_READ = ["operator.read", "operator.write", "operator.admin"], OPERATOR_WRITE = ["operator.write", "operator.admin"];

/** Resolve a feature invocation to a principal. No payload field participates:
 * tools use the host-minted memory audience; operators use `operatorAgent`,
 * which the service chooses (the default agent or an operator-only selector).
 * The returned function re-evaluates live authority on every call. */
export function featurePrincipal(context: FeatureInvocationContext, operatorRead: boolean, write: boolean, operatorAgent: string | undefined): () => Principal {
  return () => {
    if (context.source === "session-action") {
      const { client, sessionKey } = context.action;
      if (!operatorRead || !client?.connId || !client.scopes.some(s => OPERATOR_READ.includes(s))) throw denied();
      if (write && !client.scopes.some(s => OPERATOR_WRITE.includes(s))) throw denied();
      // Operators inspect an agent's private store; a session target would be
      // conversation impersonation.
      if (sessionKey) throw denied();
      if (!operatorAgent) throw Error("Several agents are configured and none is the default; choose which agent's knowledge to view.");
      return { agentId: operatorAgent, scope: { visibility: "private" } };
    }
    if (context.source !== "tool") throw denied();
    const tool = context.tool;
    context.signal?.throwIfAborted();
    if (typeof tool.assertInvocationCurrent !== "function") throw denied();
    tool.assertInvocationCurrent();
    tool.assertMemoryAudienceCurrent?.();
    return audiencePrincipal(tool.memoryAudience);
  };
}

function audiencePrincipal(audience: MemoryAudience | undefined): Principal {
  if (!audience) throw noAudience();
  if (audience.kind === "owner-private") return { agentId: audience.agentId, scope: { visibility: "private" } };
  return { agentId: audience.agentId, scope: { visibility: "conversation", sessionId: audience.sessionId } };
}

/** Provider runtime access is host-issued, not a fabricated feature/tool invocation. */
export function memoryPrincipal(context: MemoryCallerContext, requestedAgent: string, operatorRead: boolean, purpose?: "default" | "status" | "cli"): () => MemoryPrincipal {
  return () => {
    if (typeof context.assertCurrent !== "function") throw denied();
    context.signal?.throwIfAborted();
    context.assertCurrent();
    const caller = context.authority;
    if (caller.kind === "host") {
      if (purpose !== "status") throw denied();
      // The scope is internal to validation; this lease cannot release content.
      return { agentId: requestedAgent, scope: { visibility: "private" }, healthOnly: true, ownerPrivate: false };
    }
    if (caller.kind === "operator") {
      if (!operatorRead || !caller.connId || !caller.scopes.some(s => OPERATOR_READ.includes(s))) throw denied();
      return { agentId: requestedAgent, scope: { visibility: "private" }, healthOnly: false, ownerPrivate: false };
    }
    // Background host calls are not session delegation. Session identity is a
    // host-minted audience; providers consume it without reconstructing lineage.
    if (caller.kind !== "session" || caller.sandboxed) throw denied();
    const principal = audiencePrincipal(caller.audience);
    if (principal.agentId !== requestedAgent) throw denied();
    return { ...principal, healthOnly: false, ownerPrivate: caller.audience?.kind === "owner-private" };
  };
}

/** Scheduled maintenance acts on one store partition with no session,
 * operator or tool behind it. Only the plugin's own service code mints it
 * (Stores.openMaintenance); no feature, tool or provider path resolves to it,
 * and its writes are attributed to "maintenance", never an agent. */
export const MAINTENANCE_AGENT = "knowledge-maintenance";
export function maintenancePrincipal(scope: Partition): Principal { return { agentId: MAINTENANCE_AGENT, scope }; }

/** Whether a feature caller may change store assignments (spec §7). */
export function canChangeAssignments(context: FeatureInvocationContext): boolean {
  return context.source === "session-action" && Boolean(context.action.client?.connId) && Boolean(context.action.client?.scopes.includes("operator.admin"));
}

/** Pin a principal: later checks fail if live authority now resolves differently. */
export function pinPrincipal<P extends Principal>(resolve: () => P): { principal: P; assertSame(): void } {
  const principal = resolve(), identity = JSON.stringify(principal);
  return { principal, assertSame() { if (JSON.stringify(resolve()) !== identity) throw denied(); } };
}
