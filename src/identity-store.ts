import { DatabaseSync } from "node:sqlite";
import { constants, closeSync, fsyncSync, lstatSync, openSync, realpathSync } from "node:fs";
import path from "node:path";
import { Check } from "typebox/value";
import { Manifest, type IdentityStore } from "./real-vault.js";

const APPLICATION_ID = 0x4b4e4f57; // KNOW; separate plugin-owned database, never the host DB.
const unavailable = () => Error("Knowledge identity checkpoint unavailable; preserve the database and resolve recovery before reading.");

/** Short-lived connections: no native handles survive a query or plugin reload. */
export class SqliteIdentityStore implements IdentityStore {
  constructor(private readonly filename: string) {}
  private withDatabase<T>(run: (db: DatabaseSync) => T): T {
    let created = false;
    try {
      // Operational state is outside the editable vault. Reject link aliases;
      // the parent must already exist and be selected by operator configuration.
      if (realpathSync(path.dirname(this.filename)) !== path.dirname(this.filename)) throw unavailable();
      const fd = openSync(this.filename, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      closeSync(fd); created = true;
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw unavailable(); }
    const before = lstatSync(this.filename);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw unavailable();
    const db = new DatabaseSync(this.filename);
    try {
      const after = lstatSync(this.filename);
      if (before.dev !== after.dev || before.ino !== after.ino || after.nlink !== 1) throw unavailable();
      db.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
      if (created) {
        db.exec(`BEGIN IMMEDIATE;
          PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1;
          CREATE TABLE identities (agent_key TEXT PRIMARY KEY, manifest TEXT NOT NULL) STRICT;
          COMMIT;`);
        const parent = openSync(path.dirname(this.filename), constants.O_RDONLY);
        try { fsyncSync(parent); } finally { closeSync(parent); }
      }
      if (db.prepare("PRAGMA application_id").get()?.application_id !== APPLICATION_ID || db.prepare("PRAGMA user_version").get()?.user_version !== 1) throw unavailable();
      return run(db);
    } catch { throw unavailable(); }
    finally { db.close(); }
  }
  async lookup(key: string): Promise<Manifest | undefined> {
    return this.withDatabase(db => {
      const row = db.prepare("SELECT manifest FROM identities WHERE agent_key = ?").get(key);
      if (!row) return undefined;
      const value: unknown = JSON.parse(String(row.manifest));
      if (!Check(Manifest, value)) throw unavailable();
      return value;
    });
  }
  async registerIfAbsent(key: string, value: Manifest): Promise<boolean> {
    if (!Check(Manifest, value)) throw unavailable();
    return this.withDatabase(db => db.prepare("INSERT OR IGNORE INTO identities(agent_key, manifest) VALUES (?, ?)").run(key, JSON.stringify(value)).changes === 1);
  }
}
