import path from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { readText } from "./files.js";
import { SampleVault } from "./vault.js";
import type { VaultAccess } from "./access.js";

const uuid = Type.String({ pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$" });
export const Manifest = Type.Object({
  format: Type.Literal("knowledge-vault-v1"), vaultId: uuid,
  agentId: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$" }),
  generation: Type.Integer({ minimum: 0 }), publicationId: uuid,
}, { additionalProperties: false });
export type Manifest = Static<typeof Manifest>;
export const VaultConfig = Type.Object({
  root: Type.String({ minLength: 1, maxLength: 4096 }),
  statePath: Type.String({ minLength: 1, maxLength: 4096 }),
  agentId: Manifest.properties.agentId, vaultId: uuid, publicationId: uuid,
  operatorRead: Type.Boolean(),
}, { additionalProperties: false });
export type VaultConfig = Static<typeof VaultConfig>;
export type IdentityStore = { lookup(key: string): Promise<Manifest | undefined>; registerIfAbsent(key: string, value: Manifest): Promise<boolean> };
const unavailable = () => Error("Knowledge vault identity or storage is unavailable; recovery/configuration review is required.");

export function parseVaultConfig(config: Record<string, unknown> | undefined): VaultConfig | undefined {
  if (!config || !Object.keys(config).length) return undefined;
  if (Object.keys(config).some(k => k !== "vault") || !Check(VaultConfig, config.vault) || !path.isAbsolute(config.vault.root) || !path.isAbsolute(config.vault.statePath) ||
      path.resolve(config.vault.statePath) === path.resolve(config.vault.root) || path.resolve(config.vault.statePath).startsWith(path.resolve(config.vault.root) + path.sep)) throw unavailable();
  return config.vault;
}

/** Read-only generation-zero foundation. Later publication must advance the
 * manifest and this retained checkpoint through one recoverable protocol. */
export class RealVault {
  constructor(readonly config: VaultConfig, private readonly identities: IdentityStore) {}
  private async identity() {
    try {
      const rootPath = await realpath(this.config.root), stat = await lstat(this.config.root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable();
      const value: unknown = JSON.parse(await readText(rootPath, "vault.json"));
      if (!Check(Manifest, value) || value.vaultId !== this.config.vaultId || value.agentId !== this.config.agentId ||
          value.publicationId !== this.config.publicationId || value.generation !== 0) throw unavailable();
      return { manifest: { format: value.format, vaultId: value.vaultId, agentId: value.agentId, generation: value.generation, publicationId: value.publicationId }, rootPath, dev: stat.dev, ino: stat.ino };
    } catch { throw unavailable(); }
  }
  async run<T>(access: VaultAccess, operation: (vault: SampleVault) => Promise<T>): Promise<T> {
    access.assertCurrent();
    if (access.scope.agentId !== this.config.agentId) throw unavailable();
    const before = await this.identity(), key = `agent:${this.config.agentId}`;
    const existing = await this.identities.lookup(key);
    if (!existing) {
      access.assertCurrent();
      await this.identities.registerIfAbsent(key, before.manifest);
    }
    const checkpoint = await this.identities.lookup(key);
    if (JSON.stringify(checkpoint) !== JSON.stringify(before.manifest)) throw unavailable();
    const relative = access.scope.visibility === "agent-private" ? "private" : `conversations/${access.scope.sessionId}`;
    const scopedPath = path.join(before.rootPath, relative);
    let missing = false, scopeStamp = "";
    const inspectScope = async () => {
      let current = before.rootPath;
      for (const part of relative.split("/")) {
        current = path.join(current, part);
        const info = await lstat(current);
        if (!info.isDirectory() || info.isSymbolicLink() || await realpath(current) !== current) throw unavailable();
      }
      const info = await lstat(current);
      return `${info.dev}:${info.ino}`;
    };
    try { scopeStamp = await inspectScope(); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT" && access.scope.visibility === "conversation") missing = true;
      else throw unavailable();
    }
    const result = await operation(new SampleVault(scopedPath, access.scope, missing));
    access.assertCurrent();
    const after = await this.identity();
    if (JSON.stringify(after) !== JSON.stringify(before) || (!missing && await inspectScope() !== scopeStamp) ||
        JSON.stringify(await this.identities.lookup(key)) !== JSON.stringify(checkpoint)) throw unavailable();
    return result;
  }
}
