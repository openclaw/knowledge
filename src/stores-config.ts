import { createHash } from "node:crypto";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

/** Agent IDs Knowledge can bind; host agents outside this shape are reported unsupported. */
export const AGENT_ID = "^[a-z][a-z0-9_-]{0,63}$";
/** Stable named-store keys. Keys are identities, never paths or display text. */
export const STORE_KEY = "^[a-z][a-z0-9-]{0,47}$";
export const agentIdPattern = new RegExp(AGENT_ID);
export const storeKeyPattern = new RegExp(STORE_KEY);

export const NamedStore = Type.Object({
  label: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  agents: Type.Array(Type.String({ pattern: AGENT_ID }), { maxItems: 100 }),
}, { additionalProperties: false });
export type NamedStore = Static<typeof NamedStore>;
export const StoresSection = Type.Record(Type.String({ pattern: STORE_KEY }), NamedStore);
export type StoresSection = Static<typeof StoresSection>;

/** Authored plugin configuration. Membership is the only per-agent setting;
 * everything else is a plugin-wide gate. */
export const PluginConfig = Type.Object({
  operatorRead: Type.Optional(Type.Boolean()),
  writesEnabled: Type.Optional(Type.Boolean()),
  stores: Type.Optional(StoresSection),
}, { additionalProperties: false });
export type PluginConfig = Static<typeof PluginConfig>;
export type Policy = { operatorRead: boolean; writesEnabled: boolean };

/** Config path owned by the no-reload rule and every membership write. */
export const STORES_CONFIG_PATH = ["plugins", "entries", "knowledge", "config", "stores"] as const;

/** Plugin-wide gates. Both default on so a fresh install works without authoring config. */
export function parsePolicy(config: Record<string, unknown> | undefined): Policy {
  const value = config ?? {};
  if (!Check(PluginConfig, value)) throw Error("Knowledge configuration is invalid; review plugins.entries.knowledge.config.");
  return { operatorRead: value.operatorRead ?? true, writesEnabled: value.writesEnabled ?? true };
}

/** Read the authored `stores` section out of a full host config snapshot. */
export function readStoresSection(hostConfig: unknown): unknown {
  let node: unknown = hostConfig;
  for (const key of STORES_CONFIG_PATH) {
    if (!node || typeof node !== "object") return {};
    node = (node as Record<string, unknown>)[key];
  }
  return node ?? {};
}

// Key-sorted JSON so equal sections always hash equally.
export const canonicalJson = (value: unknown): string => JSON.stringify(value, (_, v) =>
  v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);

/** Settings revision: a hash of the stores section only (spec §4.1). */
export function storesRevision(section: unknown): string {
  return createHash("sha256").update(canonicalJson(section ?? {})).digest("hex");
}

/** Result of validating membership. Invalid agents never fall back to a first
 * match; they are unavailable until the configuration is repaired. */
export type Membership = {
  section: StoresSection;
  revision: string;
  /** Agent -> named store key, for validly assigned agents only. */
  assigned: ReadonlyMap<string, string>;
  /** Agents with ambiguous or otherwise invalid membership. */
  invalid: ReadonlySet<string>;
  issues: string[];
};

/** Validate an authored stores section. A structurally invalid section makes
 * every listed agent invalid rather than silently ignoring the section. */
export function parseMembership(raw: unknown): Membership {
  const revision = storesRevision(raw), issues: string[] = [];
  const assigned = new Map<string, string>(), invalid = new Set<string>();
  if (!Check(StoresSection, raw) || Object.keys(raw).some(key => !storeKeyPattern.test(key))) {
    // Salvage agent names so the affected agents are reported, never defaulted.
    for (const entry of Object.values(raw && typeof raw === "object" ? raw : {})) {
      for (const agent of (entry as { agents?: unknown })?.agents instanceof Array ? (entry as { agents: unknown[] }).agents : []) {
        if (typeof agent === "string") invalid.add(agent);
      }
    }
    return { section: {}, revision, assigned, invalid, issues: ["The stores configuration is invalid; affected agents are unavailable until it is repaired."] };
  }
  const labels = new Map<string, string>();
  for (const [key, store] of Object.entries(raw)) {
    const label = (store.label ?? key).trim().toLowerCase();
    if (labels.has(label)) issues.push(`Stores "${labels.get(label)}" and "${key}" share a display name.`);
    labels.set(label, key);
    for (const agent of store.agents) {
      const previous = assigned.get(agent);
      if (previous !== undefined && previous !== key) { invalid.add(agent); issues.push(`Agent "${agent}" is assigned to both "${previous}" and "${key}".`); }
      else assigned.set(agent, key);
    }
  }
  for (const agent of invalid) assigned.delete(agent);
  return { section: raw, revision, assigned, invalid, issues };
}

/** Logical binding for an agent: its named store, or its isolated default. */
export type Binding = `agent:${string}` | `named:${string}`;
export function effectiveBinding(membership: Membership, agentId: string): Binding | undefined {
  if (membership.invalid.has(agentId)) return undefined;
  const key = membership.assigned.get(agentId);
  return key === undefined ? `agent:${agentId}` : `named:${key}`;
}
