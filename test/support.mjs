// Shared fixtures: a host-like plugin API whose Knowledge state root holds a
// real registry, and vaults adopted into it the way the conversion does.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { StoreRegistry } from '../dist/store-registry.js';
import { featurePrincipal, pinPrincipal } from '../dist/access.js';

/** Create a store vault (v2 manifest, private partition) under `base`. */
export async function createVault(base, { name = 'vault', writesEnabled = true } = {}) {
  const root = path.join(base, name); await mkdir(path.join(root, 'private'), { recursive: true });
  const manifest = { format: 'knowledge-vault-v2', vaultId: randomUUID(), generation: 0, publicationId: randomUUID() };
  await writeFile(path.join(root, 'vault.json'), JSON.stringify(manifest));
  const config = { root, statePath: path.join(base, `${name}.sqlite`), vaultId: manifest.vaultId, publicationId: manifest.publicationId, writesEnabled };
  return { root, manifest, config };
}

/** Register an existing store under a logical binding in the state root's registry. */
export function adopt(stateRoot, binding, config, label) {
  const registry = new StoreRegistry(stateRoot);
  try { registry.adopt(binding, { vaultId: config.vaultId, publicationId: config.publicationId, root: config.root, statePath: config.statePath }, label); }
  finally { registry.close(); }
}

/** A plugin API with host config, state dir and config mutation. `hostConfig`
 * is live: tests may edit it to simulate external configuration edits. */
export function hostApi(base, { agents = ['main'], stores = {}, policy = {}, lag = false, extra = {} } = {}) {
  const stateDir = path.join(base, 'state');
  const host = { config: { agents: { list: agents.map((id, i) => ({ id, ...(i === 0 ? { default: true } : {}) })) }, plugins: { entries: { knowledge: { config: { ...policy, stores } } } } } };
  const writes = [];
  const api = {
    id: 'knowledge', pluginConfig: { ...policy },
    runtime: {
      state: { resolveStateDir: () => stateDir },
      agent: { resolveAgentIdentity: (_cfg, id) => ({ name: id[0].toUpperCase() + id.slice(1) }) },
      config: {
        current: () => host.config,
        async mutateConfigFile({ mutate }) {
          // Mutations start from the persisted file, which may be ahead of config.current().
          const draft = structuredClone(host.pending ?? host.config);
          await mutate(draft, { snapshot: {}, previousHash: null });
          writes.push(draft);
          // Real hosts publish a write to config.current() after it resolves.
          if (lag) host.pending = draft; else host.config = draft;
          return { nextConfig: draft, persistedHash: String(writes.length) };
        },
      },
    },
    ...extra,
  };
  return { api, host, writes, stateDir, stateRoot: path.join(stateDir, 'knowledge'),
    /** Publish a lagged write, as the host eventually does. */
    publish() { if (host.pending) { host.config = host.pending; host.pending = undefined; } } };
}

/** Owner-direct tool context for an agent. */
export const toolContext = (api, agentId = 'main', audience = { kind: 'owner-private', agentId }) =>
  ({ source: 'tool', api, tool: { agentId, memoryAudience: audience, assertInvocationCurrent() {}, assertMemoryAudienceCurrent() {} } });
/** Operator session-action context. */
export const operatorContext = (api, scopes = ['operator.write']) => ({ source: 'session-action', api, action: { client: { connId: 'test', scopes } } });
/** Pinned access for direct storage calls, from a feature context. */
export function accessFor(context, write = false, operatorAgent = 'main') {
  const pinned = pinPrincipal(featurePrincipal(context, true, write, operatorAgent));
  return { ...pinned.principal, assertCurrent: pinned.assertSame };
}
/** Plain access for storage-level tests that do not exercise authority. */
export const plainAccess = (scope = { visibility: 'private' }, agentId = 'main') => ({ scope, agentId, assertCurrent() {} });

/** One-call fixture: a vault adopted as `agent:main` plus a host API. */
export async function storeFixture(base, options = {}) {
  const vault = await createVault(base, options);
  const host = hostApi(base, options);
  adopt(host.stateRoot, options.binding ?? 'agent:main', vault.config);
  return { ...vault, ...host };
}

/** Host API for a test-created vault: adopts it as `agent:main` and takes the
 * plugin-wide gates from the vault config's legacy-named test fields. */
export function apiFor(base, config, options = {}) {
  const host = hostApi(base, { ...options, policy: { operatorRead: config.operatorRead ?? true, writesEnabled: config.writesEnabled ?? false, ...options.policy } });
  adopt(host.stateRoot, options.binding ?? 'agent:main', config);
  return host.api;
}
