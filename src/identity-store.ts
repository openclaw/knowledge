import { DatabaseSync } from "node:sqlite";
import { constants, closeSync, fsyncSync, lstatSync, openSync, realpathSync } from "node:fs";
import path from "node:path";
import { Check } from "typebox/value";
import { Manifest } from "./store-manifest.js";
import type { IdentityStore } from "./real-vault.js";

const APPLICATION_ID = 0x4b4e4f57; // KNOW; separate plugin-owned database, never the host DB.
const unavailable = () => Error("Knowledge identity checkpoint unavailable; preserve the database and resolve recovery before reading.");

/** Short-lived connections: no native handles survive a query or plugin reload. */
export class SqliteIdentityStore implements IdentityStore {
  constructor(private readonly filename: string) {}
  withDatabase<T>(run: (db: DatabaseSync) => T): T {
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
      if (db.prepare("PRAGMA application_id").get()?.application_id !== APPLICATION_ID || ![1, 2, 3, 4, 5].includes(Number(db.prepare("PRAGMA user_version").get()?.user_version))) throw unavailable();
      if (db.prepare("PRAGMA user_version").get()?.user_version === 1) db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS mutations (
          scope TEXT NOT NULL, request TEXT NOT NULL, intent TEXT NOT NULL,
          state TEXT NOT NULL, plan TEXT NOT NULL, receipt TEXT NOT NULL,
          PRIMARY KEY(scope, request)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS observations (
          scope TEXT NOT NULL, id TEXT NOT NULL, path TEXT NOT NULL, hash TEXT NOT NULL,
          revision INTEGER NOT NULL, raw TEXT NOT NULL, PRIMARY KEY(scope,id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS history (
          sequence INTEGER PRIMARY KEY, scope TEXT NOT NULL, id TEXT NOT NULL,
          provenance TEXT NOT NULL, at TEXT NOT NULL, path TEXT NOT NULL,
          revision INTEGER NOT NULL, hash TEXT NOT NULL, raw TEXT NOT NULL
        ) STRICT;
        PRAGMA user_version=2;
        COMMIT;`);
      if (db.prepare("PRAGMA user_version").get()?.user_version === 2) db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE git_jobs (
          sequence INTEGER PRIMARY KEY, scope TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
          batch TEXT NOT NULL, state TEXT NOT NULL, commit_id TEXT, message TEXT NOT NULL
        ) STRICT;
        CREATE TABLE git_files (scope TEXT NOT NULL, path TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(scope,path)) STRICT;
        PRAGMA user_version=3;
        COMMIT;`);
      if (db.prepare("PRAGMA user_version").get()?.user_version === 3) db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE attachment_uploads (
          scope TEXT NOT NULL, request TEXT NOT NULL, metadata TEXT NOT NULL,
          received INTEGER NOT NULL, receipt TEXT, PRIMARY KEY(scope,request)
        ) STRICT;
        CREATE TABLE attachment_chunks (
          scope TEXT NOT NULL, request TEXT NOT NULL, offset INTEGER NOT NULL,
          hash TEXT NOT NULL, size INTEGER NOT NULL, final INTEGER NOT NULL, data BLOB,
          PRIMARY KEY(scope,request,offset)
        ) STRICT;
        PRAGMA user_version=4; COMMIT;`);
      // Writer attribution: the agent that published a revision. Stores are
      // shared, so the partition no longer implies the author.
      if (db.prepare("PRAGMA user_version").get()?.user_version === 4) db.exec(`BEGIN IMMEDIATE;
        ALTER TABLE history ADD COLUMN agent_id TEXT;
        PRAGMA user_version=5; COMMIT;`);
      // Additive indexes remain readable by older plugin versions. The activity
      // projection joins exact publication snapshots to history; without this
      // key every published record scans the entire history table again.
      db.exec(`CREATE INDEX IF NOT EXISTS history_record_snapshot ON history(scope,id,hash,revision,provenance,sequence);
        CREATE INDEX IF NOT EXISTS history_scope_sequence ON history(scope,sequence);`);
      return run(db);
    } finally { db.close(); }
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
