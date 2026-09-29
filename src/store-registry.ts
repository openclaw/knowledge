import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, writeSync } from "node:fs";
import path from "node:path";
import { Check } from "typebox/value";
import { Manifest, checkpointKey } from "./store-manifest.js";
import { SqliteIdentityStore } from "./identity-store.js";
import { canonicalJson } from "./stores-config.js";
import type { StoreState } from "./stores-contract.js";

const APPLICATION_ID = 0x4b4e5247; // KNRG; Knowledge store registry, never the host DB.

/** A provisioned (or reserved) physical store. Paths are registry-internal facts. */
export type StoreRow = { vaultId: string; publicationId: string; root: string; statePath: string; state: "initializing" | "ready"; createdAt: string };
/** A journaled assignment change (spec §7). */
export type OperationRow = {
  requestId: string; intent: string; state: "pending" | "applied" | "not-applied" | "conflict";
  expectedRevision: string; nextSection: string; nextRevision: string;
  rebind: { from: string; to: string; label: string } | null; message: string; updatedAt: string;
};
/** Everything the main thread needs to resolve stores synchronously. */
export type RegistrySnapshot = {
  stores: Record<string, StoreRow & { present: boolean }>;
  /** Logical binding -> vaultId. Each physical store has at most one binding. */
  bindings: Record<string, string>;
  labels: Record<string, string>;
  reconciled: { section: string; revision: string } | null;
  pending: OperationRow | null;
};
export class RegistryRecoveryRequired extends Error {}

/** Recommended registry and store layout under the Knowledge state root. */
export const registryPaths = (stateRoot: string) => ({ registry: path.join(stateRoot, "registry.sqlite"), stores: path.join(stateRoot, "stores"), sentinel: path.join(stateRoot, "registry.id") });

/** Registry owner. Runs in the registry worker; every method is synchronous
 * SQLite plus filesystem work and never runs on the Gateway main thread. */
export class StoreRegistry {
  private readonly db: DatabaseSync;
  /** Canonical state root: store paths are recorded without symlinks, which
   * the operational database's link guard would otherwise reject. */
  readonly stateRoot: string;
  /** `converting` is only for the conversion tool, which owns an unfinished journal. */
  constructor(stateRoot: string, options: { converting?: boolean } = {}) {
    mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    this.stateRoot = stateRoot = realpathSync(stateRoot);
    const { registry, stores, sentinel } = registryPaths(stateRoot);
    // Adopted stores live outside stores/, so a missing or emptied registry is
    // detected through the sentinel written when the registry was created.
    const hadRegistry = isFile(registry) && lstatSync(registry).size > 0;
    if (!hadRegistry && (existsSync(sentinel) || (existsSync(stores) && readdirSync(stores).length))) {
      // Discovering and adopting stores would be a guess about identity.
      throw new RegistryRecoveryRequired("Knowledge store registry is missing or empty while stores exist; restore registry.sqlite from backup.");
    }
    this.db = new DatabaseSync(registry);
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
    const version = Number(this.db.prepare("PRAGMA user_version").get()?.user_version);
    if (version === 0) this.db.exec(`BEGIN IMMEDIATE;
      PRAGMA application_id=${APPLICATION_ID};
      CREATE TABLE stores (
        vault_id TEXT PRIMARY KEY, publication_id TEXT NOT NULL, root TEXT NOT NULL UNIQUE,
        state_path TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK(state IN ('initializing','ready')), created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE bindings (
        binding TEXT PRIMARY KEY, vault_id TEXT NOT NULL UNIQUE REFERENCES stores(vault_id), label TEXT
      ) STRICT;
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      INSERT INTO meta VALUES ('registry_id', '${randomUUID()}');
      CREATE TABLE operations (
        request_id TEXT PRIMARY KEY, intent TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','applied','not-applied','conflict')),
        expected_revision TEXT NOT NULL, next_section TEXT NOT NULL, next_revision TEXT NOT NULL,
        rebind TEXT, message TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      PRAGMA user_version=1;
      COMMIT;`);
    if (this.db.prepare("PRAGMA application_id").get()?.application_id !== APPLICATION_ID || Number(this.db.prepare("PRAGMA user_version").get()?.user_version) !== 1) {
      this.db.close();
      throw new RegistryRecoveryRequired("Knowledge store registry is not a recognized registry database; recovery review required.");
    }
    const id = this.meta("registry_id")!;
    if (existsSync(sentinel) && readFileSync(sentinel, "utf8").trim() !== id) {
      this.db.close();
      throw new RegistryRecoveryRequired("Knowledge store registry does not match this state directory; restore the original registry.sqlite.");
    }
    if (!existsSync(sentinel)) { writeOnce(sentinel, id + "\n"); fsyncDir(stateRoot); }
    // A conversion journals itself here first; until it completes, serving
    // could provision a second, empty store for the agent being converted.
    const conversion = this.meta("conversion");
    if (conversion && JSON.parse(conversion).stage !== "complete" && !options.converting) {
      this.db.close();
      throw new RegistryRecoveryRequired("A Knowledge store conversion is in progress; finish or restore it before starting Knowledge.");
    }
  }
  close() { this.db.close(); }
  /** Conversion journal (scripts/convert-to-stores.mjs); never used while serving. */
  conversion(value?: Record<string, unknown>): Record<string, unknown> | null {
    if (value) this.tx(() => this.setMeta("conversion", JSON.stringify(value)));
    const raw = this.meta("conversion");
    return raw ? JSON.parse(raw) : null;
  }

  private tx<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = run(); this.db.exec("COMMIT"); return result; }
    catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  private meta(key: string): string | null { return (this.db.prepare("SELECT value FROM meta WHERE key=?").get(key)?.value as string | undefined) ?? null; }
  private setMeta(key: string, value: string | null) {
    if (value === null) this.db.prepare("DELETE FROM meta WHERE key=?").run(key);
    else this.db.prepare("INSERT OR REPLACE INTO meta VALUES (?,?)").run(key, value);
  }
  private store(vaultId: string): StoreRow | undefined {
    const row = this.db.prepare("SELECT * FROM stores WHERE vault_id=?").get(vaultId);
    return row && { vaultId: String(row.vault_id), publicationId: String(row.publication_id), root: String(row.root), statePath: String(row.state_path), state: row.state as StoreRow["state"], createdAt: String(row.created_at) };
  }
  private operationRow(row: Record<string, unknown> | undefined): OperationRow | undefined {
    return row && { requestId: String(row.request_id), intent: String(row.intent), state: row.state as OperationRow["state"],
      expectedRevision: String(row.expected_revision), nextSection: String(row.next_section), nextRevision: String(row.next_revision),
      rebind: row.rebind ? JSON.parse(String(row.rebind)) : null, message: String(row.message), updatedAt: String(row.updated_at) };
  }

  /** Non-provisioning view. Presence is a cheap lstat; nothing is created. */
  snapshot(): RegistrySnapshot {
    const stores: RegistrySnapshot["stores"] = {}, bindings: Record<string, string> = {}, labels: Record<string, string> = {};
    for (const row of this.db.prepare("SELECT vault_id FROM stores").all()) {
      const store = this.store(String(row.vault_id))!;
      stores[store.vaultId] = { ...store, present: isFile(path.join(store.root, "vault.json")) && isFile(store.statePath) };
    }
    for (const row of this.db.prepare("SELECT * FROM bindings").all()) {
      bindings[String(row.binding)] = String(row.vault_id);
      if (row.label) labels[String(row.binding)] = String(row.label);
    }
    const section = this.meta("reconciled_section"), revision = this.meta("reconciled_revision");
    return { stores, bindings, labels, reconciled: section !== null && revision !== null ? { section, revision } : null,
      pending: this.operationRow(this.db.prepare("SELECT * FROM operations WHERE state='pending' ORDER BY updated_at LIMIT 1").get()) ?? null };
  }

  /** Lazily create the store behind a logical binding (spec §5.2). The
   * reservation commits before any file exists, so an interrupted attempt
   * resumes the same UUID instead of inventing a second identity. */
  provision(binding: string): RegistrySnapshot {
    const reserved = this.tx(() => {
      const bound = this.db.prepare("SELECT vault_id FROM bindings WHERE binding=?").get(binding);
      if (bound) return this.store(String(bound.vault_id))!;
      const vaultId = randomUUID(), dir = path.join(registryPaths(this.stateRoot).stores, vaultId);
      const row: StoreRow = { vaultId, publicationId: randomUUID(), root: path.join(dir, "vault"), statePath: path.join(dir, "state.sqlite"), state: "initializing", createdAt: new Date().toISOString() };
      this.db.prepare("INSERT INTO stores VALUES (?,?,?,?,?,?)").run(row.vaultId, row.publicationId, row.root, row.statePath, row.state, row.createdAt);
      this.db.prepare("INSERT INTO bindings(binding,vault_id) VALUES (?,?)").run(binding, vaultId);
      return row;
    });
    if (reserved.state === "ready") return this.snapshot();
    const manifest: Manifest = { format: "knowledge-vault-v2", vaultId: reserved.vaultId, generation: 0, publicationId: reserved.publicationId };
    mkdirSync(path.join(reserved.root, "private"), { recursive: true, mode: 0o700 });
    writeOnce(path.join(reserved.root, "vault.json"), JSON.stringify(manifest, null, 2) + "\n");
    fsyncDir(reserved.root); fsyncDir(path.dirname(reserved.root));
    const store = new SqliteIdentityStore(reserved.statePath);
    store.withDatabase(db => { db.prepare("INSERT OR IGNORE INTO identities(agent_key, manifest) VALUES (?, ?)").run(checkpointKey(reserved.vaultId), JSON.stringify(manifest)); });
    // Verify the complete manifest/database pair before publishing readiness.
    const written: unknown = JSON.parse(readFileSync(path.join(reserved.root, "vault.json"), "utf8"));
    const checkpoint = store.withDatabase(db => db.prepare("SELECT manifest FROM identities WHERE agent_key=?").get(checkpointKey(reserved.vaultId))?.manifest);
    if (!Check(Manifest, written) || canonicalJson(written) !== canonicalJson(manifest) || typeof checkpoint !== "string" || canonicalJson(JSON.parse(checkpoint)) !== canonicalJson(manifest)) {
      throw new RegistryRecoveryRequired("Knowledge store initialization found unexpected existing storage; recovery review required.");
    }
    this.tx(() => { this.db.prepare("UPDATE stores SET state='ready' WHERE vault_id=? AND state='initializing'").run(reserved.vaultId); });
    return this.snapshot();
  }

  /** Register an existing, already-converted store in place (conversion and
   * fixtures). Refuses to rebind a binding or store that is already known. */
  adopt(binding: string, row: Omit<StoreRow, "state" | "createdAt">, label?: string): RegistrySnapshot {
    const manifest: unknown = JSON.parse(readFileSync(path.join(row.root, "vault.json"), "utf8"));
    if (!Check(Manifest, manifest) || manifest.vaultId !== row.vaultId || manifest.publicationId !== row.publicationId && manifest.generation === 0) throw Error("Adopted store manifest does not match its registry identity.");
    if (this.db.prepare("SELECT 1 FROM bindings WHERE binding=?").get(binding) || this.db.prepare("SELECT 1 FROM stores WHERE vault_id=? OR root=? OR state_path=?").get(row.vaultId, row.root, row.statePath)) {
      throw Error("That binding or store is already registered.");
    }
    // A published store keeps its journal: never create its database here, and
    // require its checkpoint to match. Only a never-published (generation 0)
    // store may get a fresh database and first checkpoint.
    if (!isFile(row.statePath) && manifest.generation !== 0) throw Error("Adopted store's operational database is missing.");
    const store = new SqliteIdentityStore(row.statePath);
    const checkpoint = store.withDatabase(db => db.prepare("SELECT manifest FROM identities WHERE agent_key=?").get(checkpointKey(row.vaultId))?.manifest);
    if (typeof checkpoint === "string" ? canonicalJson(JSON.parse(checkpoint)) !== canonicalJson(manifest) : manifest.generation !== 0) {
      throw Error("Adopted store's identity checkpoint does not match its manifest.");
    }
    if (checkpoint === undefined) store.withDatabase(db => { db.prepare("INSERT OR IGNORE INTO identities(agent_key, manifest) VALUES (?, ?)").run(checkpointKey(row.vaultId), JSON.stringify(manifest)); });
    this.tx(() => {
      this.db.prepare("INSERT INTO stores VALUES (?,?,?,?,'ready',?)").run(row.vaultId, row.publicationId, row.root, row.statePath, new Date().toISOString());
      this.db.prepare("INSERT INTO bindings VALUES (?,?,?)").run(binding, row.vaultId, label ?? null);
    });
    return this.snapshot();
  }

  /** Record the membership section Knowledge now enforces. */
  reconcile(section: string, revision: string): RegistrySnapshot {
    this.tx(() => { this.setMeta("reconciled_section", section); this.setMeta("reconciled_revision", revision); });
    return this.snapshot();
  }

  operation(requestId: string): OperationRow | null {
    return this.operationRow(this.db.prepare("SELECT * FROM operations WHERE request_id=?").get(requestId)) ?? null;
  }
  /** Journal an intent before any fence or config write. One pending change at a time. */
  begin(op: Omit<OperationRow, "state" | "message" | "updatedAt">): RegistrySnapshot {
    this.tx(() => {
      if (this.db.prepare("SELECT 1 FROM operations WHERE state='pending'").get()) throw Error("Another store assignment change is still being applied.");
      this.db.prepare("INSERT INTO operations VALUES (?,?,'pending',?,?,?,?,?,?)").run(op.requestId, op.intent, op.expectedRevision, op.nextSection, op.nextRevision,
        op.rebind ? JSON.stringify(op.rebind) : null, "Applying the assignment change.", new Date().toISOString());
    });
    return this.snapshot();
  }
  /** Settle a journaled change. `applied` records the new section; `rebind`
   * moves a shared store's binding whenever the persisted configuration names
   * it, even if other edits made the overall outcome a conflict. */
  settle(requestId: string, state: Exclude<OperationRow["state"], "pending">, message: string, rebind: boolean): RegistrySnapshot {
    this.tx(() => {
      const op = this.operation(requestId);
      if (!op || op.state !== "pending") throw Error("No pending assignment change with this request ID.");
      if (rebind || state === "applied") {
        if (op.rebind) {
          const target = this.db.prepare("SELECT vault_id FROM bindings WHERE binding=?").get(op.rebind.to);
          const source = this.db.prepare("SELECT vault_id FROM bindings WHERE binding=?").get(op.rebind.from);
          if (!source && !target) throw new RegistryRecoveryRequired("The shared store's registry binding is missing; recovery review required.");
          if (source && target) throw new RegistryRecoveryRequired("Both the original and the named binding exist; recovery review required.");
          if (source) this.db.prepare("UPDATE bindings SET binding=?, label=? WHERE binding=?").run(op.rebind.to, op.rebind.label, op.rebind.from);
        }
      }
      if (state === "applied") { this.setMeta("reconciled_section", op.nextSection); this.setMeta("reconciled_revision", op.nextRevision); }
      this.db.prepare("UPDATE operations SET state=?, message=?, updated_at=? WHERE request_id=?").run(state, message.slice(0, 1000), new Date().toISOString(), requestId);
    });
    return this.snapshot();
  }
  /** Keep display labels for named stores current with configuration. */
  label(binding: string, label: string | null): RegistrySnapshot {
    this.tx(() => { this.db.prepare("UPDATE bindings SET label=? WHERE binding=?").run(label, binding); });
    return this.snapshot();
  }
}

/** Registry state for a binding. `presence` folds in the cheap file check for
 * inventory display; opening a store ignores it and lets storage identity
 * checks decide, since an interrupted publication legitimately displaces
 * vault.json until recovery completes. */
export function bindingState(snapshot: RegistrySnapshot, binding: string, presence = true): StoreState {
  const vaultId = snapshot.bindings[binding];
  if (!vaultId) return "unprovisioned";
  const store = snapshot.stores[vaultId];
  if (!store) return "recovery-required";
  if (store.state === "initializing") return "initializing";
  return store.present || !presence ? "ready" : "unavailable";
}

function isFile(file: string) { try { const s = lstatSync(file); return s.isFile() && !s.isSymbolicLink(); } catch { return false; } }
// Create exactly once; an existing file is verified by the caller, never replaced.
function writeOnce(file: string, text: string) {
  let fd: number;
  try { fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") return; throw e; }
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
}
function fsyncDir(dir: string) { const fd = openSync(dir, constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); } }
