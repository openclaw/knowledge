#!/usr/bin/env node
// One-time, in-place conversion of a single-vault Knowledge installation to
// store-owned identity (docs/STORES_AND_SHARING_SPEC.md §9). Run it only while
// the Gateway is stopped. It never edits OpenClaw configuration: it prints the
// `openclaw config set` command that activates the converted installation.
//
//   node scripts/convert-to-stores.mjs --legacy <vault-config.json> --state-dir <openclaw state dir> --backup <dir> [--apply] [--quiesced]
//   node scripts/convert-to-stores.mjs --restore <backup dir> --state-dir <openclaw state dir> --quiesced
//
// Without --apply it only runs the preflight and prints the plan.
import { createHash, randomUUID } from 'node:crypto';
import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite';
import { closeSync, constants, cpSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Check } from 'typebox/value';
import { parse as parseYaml } from 'yaml';
import { Envelope } from '../dist/model.js';
import { SqliteIdentityStore } from '../dist/identity-store.js';
import { StoreRegistry } from '../dist/store-registry.js';
import { checkpointKey } from '../dist/store-manifest.js';
import { storesRevision, canonicalJson } from '../dist/stores-config.js';

const { values: args } = parseArgs({ options: {
  legacy: { type: 'string' }, 'state-dir': { type: 'string' }, backup: { type: 'string' }, restore: { type: 'string' },
  apply: { type: 'boolean' }, quiesced: { type: 'boolean' },
} });
const sha = text => createHash('sha256').update(text).digest('hex');
const fail = message => { console.error(`convert-to-stores: ${message}`); process.exit(1); };
const log = message => console.log(message);
// Recovery drills only: stop right after a named stage, as a crash would.
const stopAfter = stage => { if (process.env.KNOWLEDGE_CONVERT_STOP_AFTER === stage) { log(`Stopped after ${stage} (drill).`); process.exit(75); } };
if (!args['state-dir']) fail('--state-dir is required (the OpenClaw state directory, e.g. ~/.openclaw).');
const stateRoot = path.join(path.resolve(args['state-dir']), 'knowledge');

if (args.restore) restore(path.resolve(args.restore));
else convert();

/** Preflight, back up, convert records/DB/manifest, then register the store. */
function convert() {
  if (!args.legacy || !args.backup) fail('--legacy and --backup are required.');
  // The legacy plugin config: `openclaw config get plugins.entries.knowledge.config --json`.
  const legacyConfig = JSON.parse(readFileSync(path.resolve(args.legacy), 'utf8'));
  const legacy = legacyConfig.vault ?? legacyConfig;
  for (const key of ['root', 'statePath', 'agentId', 'vaultId', 'publicationId']) if (typeof legacy[key] !== 'string') fail(`legacy vault config is missing ${key}.`);
  const registryPath = path.join(stateRoot, 'registry.sqlite');
  let journal = existsSync(registryPath) ? openRegistry().conversionAndClose() : null;
  if (journal?.stage === 'complete') fail('this installation is already converted.');
  if (existsSync(registryPath) && !journal) fail('a store registry already exists; refusing to convert over it.');

  const manifestPath = path.join(legacy.root, 'vault.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const v2 = { format: 'knowledge-vault-v2', vaultId: manifest.vaultId, generation: manifest.generation, publicationId: manifest.publicationId };
  if (manifest.vaultId !== legacy.vaultId) fail('vault.json does not match the configured vault.');
  if (!journal) preflight(legacy, manifest);
  // Before a backup exists the live vault is the legacy text; afterwards the
  // backup is, so a resumed run still sees every original byte.
  const records = scanRecords(journal?.backupDir ? path.join(journal.backupDir, 'vault') : legacy.root, legacy.root, legacy.agentId);
  log(`Vault ${legacy.vaultId} (agent ${legacy.agentId}) at ${legacy.root}`);
  log(`  records to convert: ${records.filter(r => r.after !== r.before).length}`);
  log(`  state database: ${legacy.statePath}`);
  if (!args.apply) { log('Dry run only; rerun with --apply --quiesced after stopping the Gateway.'); return; }
  if (!args.quiesced) fail('stop the Gateway first, then pass --quiesced.');

  // 1. Journal, then back up. The journal lives in the new registry, which
  // refuses to serve until this conversion completes.
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  if (!journal) {
    const backupDir = path.join(path.resolve(args.backup), `knowledge-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    mkdirSync(backupDir, { recursive: true });
    cpSync(legacy.root, path.join(backupDir, 'vault'), { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    writeFileSync(path.join(backupDir, 'legacy-config.json'), JSON.stringify(legacyConfig, null, 2));
    journal = { stage: 'backing-up', legacy, backupDir, startedAt: new Date().toISOString() };
    setJournal(journal);
    return backupDatabase(legacy, backupDir).then(() => {
      writeFileSync(path.join(backupDir, 'inventory.json'), JSON.stringify(inventory(legacy), null, 2));
      setJournal(journal = { ...journal, stage: 'backed-up' });
      finish(legacy, v2, scanRecords(path.join(backupDir, 'vault'), legacy.root, legacy.agentId), journal);
    });
  }
  log(`Resuming conversion at stage ${journal.stage}.`);
  if (journal.stage === 'backing-up') fail(`the backup did not finish; remove ${registryPath} and ${journal.backupDir} and rerun.`);
  finish(legacy, v2, records, journal);
}

// Stages after the backup are idempotent, so an interruption resumes here.
function finish(legacy, v2, records, journal) {
  // 2. Record envelopes: store-owned scope, written atomically per file.
  for (const record of records) if (record.after !== record.before && readFileSync(record.file, 'utf8') !== record.after) atomicWrite(record.file, record.after);
  stopAfter('rewriting');
  if (journal.stage === 'backed-up') setJournal(journal = { ...journal, stage: 'records' });
  stopAfter('records');
  // 3. Operational state, in one transaction (re-running it is harmless).
  if (journal.stage === 'records') { convertDatabase(legacy, v2, records); stopAfter('database-commit'); setJournal(journal = { ...journal, stage: 'database' }); }
  // 4. Manifest: same identity, generation and publication fence.
  atomicWrite(path.join(legacy.root, 'vault.json'), JSON.stringify(v2, null, 2) + '\n');
  // 5. Register the same store as the agent's isolated default, in place.
  const registry = new StoreRegistry(stateRoot, { converting: true });
  try {
    if (!registry.snapshot().bindings[`agent:${legacy.agentId}`]) {
      registry.adopt(`agent:${legacy.agentId}`, { vaultId: v2.vaultId, publicationId: v2.publicationId, root: legacy.root, statePath: legacy.statePath });
    }
    registry.reconcile(canonicalJson({}), storesRevision({}));
    registry.conversion({ ...journal, stage: 'complete', completedAt: new Date().toISOString() });
  } finally { registry.close(); }
  const next = { ...(legacy.operatorRead !== undefined ? { operatorRead: legacy.operatorRead } : {}), ...(legacy.writesEnabled !== undefined ? { writesEnabled: legacy.writesEnabled } : {}) };
  log('Conversion complete. Activate it (replaces the retired `vault` settings), then start the Gateway:');
  log(`  openclaw config set plugins.entries.knowledge.config '${JSON.stringify(next)}' --strict-json`);
  log(`Backup: ${journal.backupDir}`);
}

/** Refuse to convert anything with unfinished work; it must settle first. */
function preflight(legacy, manifest) {
  if (manifest.format !== 'knowledge-vault-v1' || manifest.agentId !== legacy.agentId) fail('vault.json is not a legacy single-agent manifest for this agent.');
  const db = new DatabaseSync(legacy.statePath, { readOnly: true });
  try {
    const checkpoint = db.prepare('SELECT manifest FROM identities WHERE agent_key=?').get(`agent:${legacy.agentId}`);
    if (!checkpoint || canonicalJson(JSON.parse(String(checkpoint.manifest))) !== canonicalJson(manifest)) fail('the identity checkpoint does not match vault.json; resolve recovery first.');
    const pending = db.prepare("SELECT count(*) AS n FROM mutations WHERE state!='published'").get().n;
    const git = db.prepare("SELECT count(*) AS n FROM git_jobs WHERE state!='committed'").get().n;
    const uploads = db.prepare('SELECT count(*) AS n FROM attachment_uploads WHERE receipt IS NULL').get().n;
    if (pending || git || uploads) fail(`unfinished work: ${pending} publication(s), ${git} Git checkpoint(s), ${uploads} upload(s). Resume or resolve them first.`);
  } finally { db.close(); }
}

/** Every record file with its converted text. Recovery payloads under
 * dot-directories keep their historical format. */
function scanRecords(root, liveRoot, agentId) {
  const out = [], partitions = [['private', 'private']];
  const conversations = path.join(root, 'conversations');
  if (existsSync(conversations)) for (const id of readdirSync(conversations)) if (!id.startsWith('.')) partitions.push([`conversations/${id}`, id]);
  for (const [relative, partition] of partitions) {
    const dir = path.join(root, relative);
    for (const file of readdirSync(dir, { recursive: true })) {
      const parts = String(file).split(path.sep);
      if (!String(file).endsWith('.md') || parts.some(p => p.startsWith('.')) || ['README.md', 'RESOLVER.md'].includes(parts.at(-1))) continue;
      const full = path.join(dir, String(file)), before = readFileSync(full, 'utf8');
      const legacyScope = partition === 'private'
        ? `scope:\n  visibility: agent-private\n  agentId: ${agentId}\n`
        : `scope:\n  visibility: conversation\n  agentId: ${agentId}\n  sessionId: ${partition}\n`;
      const nextScope = partition === 'private' ? 'scope:\n  visibility: private\n' : `scope:\n  visibility: conversation\n  sessionId: ${partition}\n`;
      const match = /^(?:﻿)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(before);
      const header = match?.[1] + '\n';
      // Only the exact legacy block inside the frontmatter is rewritten.
      const after = match && header.includes(legacyScope) ? before.replace(match[0], match[0].replace(legacyScope, nextScope)) : before;
      const scope = match ? (() => { try { return parseYaml(match[1])?.scope; } catch { return undefined; } })() : undefined;
      const converted = after !== before || (scope && Check(Envelope.properties.scope, scope) && scope.visibility !== 'sample');
      // Files that were never valid records in this partition stay untouched and reported.
      if (!converted) { log(`  left unchanged (not a valid record for this partition): ${relative}/${file}`); continue; }
      out.push({ file: path.join(liveRoot, relative, String(file)), scopeKey: relative, path: String(file).split(path.sep).join('/'), before, after });
    }
  }
  return out;
}

/** Operational references follow the new bytes; meaning does not change. */
function convertDatabase(legacy, v2, records) {
  // Opening through the plugin applies its schema migrations (writer attribution).
  new SqliteIdentityStore(legacy.statePath).withDatabase(db => {
    db.exec('BEGIN IMMEDIATE');
    try {
      // Every agent-published revision so far was written by the legacy agent.
      db.prepare("UPDATE history SET agent_id=? WHERE provenance='agent' AND agent_id IS NULL").run(legacy.agentId);
      const now = new Date().toISOString(), changes = [];
      for (const r of records) {
        if (r.after === r.before) continue;
        const observation = db.prepare('SELECT * FROM observations WHERE scope=? AND path=?').get(r.scopeKey, r.path);
        if (observation && observation.hash === sha(r.before)) {
          db.prepare('UPDATE observations SET hash=?, raw=? WHERE scope=? AND id=?').run(sha(r.after), r.after, r.scopeKey, observation.id);
          db.prepare('INSERT INTO history(scope,id,provenance,at,path,revision,hash,raw,agent_id) VALUES (?,?,?,?,?,?,?,?,NULL)')
            .run(r.scopeKey, observation.id, 'conversion', now, r.path, observation.revision, sha(r.after), r.after);
        }
        const gitPath = `${r.scopeKey}/${r.path}`, tracked = db.prepare('SELECT hash FROM git_files WHERE scope=? AND path=?').get(r.scopeKey, gitPath);
        if (tracked?.hash === sha(r.before)) { changes.push({ path: gitPath, raw: r.after }); db.prepare('UPDATE git_files SET hash=? WHERE scope=? AND path=?').run(sha(r.after), r.scopeKey, gitPath); }
      }
      // One local Git checkpoint for the whole conversion, per partition.
      const byScope = new Map();
      for (const c of changes) { const scope = c.path.startsWith('private/') ? 'private' : c.path.split('/').slice(0, 2).join('/'); byScope.set(scope, [...(byScope.get(scope) ?? []), c]); }
      for (const [scope, batch] of byScope) db.prepare("INSERT OR IGNORE INTO git_jobs(scope,token,batch,state,message) VALUES (?,?,?,'pending','Local Git checkpoint pending.')")
        .run(scope, sha(`conversion:${v2.vaultId}:${scope}`), JSON.stringify({ token: sha(`conversion:${v2.vaultId}:${scope}`), changes: batch, actor: 'conversion', at: now }));
      db.prepare('DELETE FROM identities WHERE agent_key=?').run(`agent:${legacy.agentId}`);
      db.prepare('INSERT OR REPLACE INTO identities(agent_key, manifest) VALUES (?, ?)').run(checkpointKey(v2.vaultId), JSON.stringify(v2));
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  });
}

/** Restore a matched vault/database set and remove the registry, unless the
 * converted store has recorded new revisions (those would be discarded). */
function restore(backupDir) {
  if (!args.quiesced) fail('stop the Gateway first, then pass --quiesced.');
  const legacyConfig = JSON.parse(readFileSync(path.join(backupDir, 'legacy-config.json'), 'utf8')), legacy = legacyConfig.vault ?? legacyConfig;
  if (existsSync(legacy.statePath)) {
    const db = new DatabaseSync(legacy.statePath, { readOnly: true });
    try {
      const hasColumn = db.prepare("SELECT 1 FROM pragma_table_info('history') WHERE name='agent_id'").get();
      const conversionAt = hasColumn ? db.prepare("SELECT max(sequence) AS s FROM history WHERE provenance='conversion'").get().s : null;
      const newer = conversionAt ? db.prepare("SELECT count(*) AS n FROM history WHERE sequence > ? AND provenance!='conversion'").get(conversionAt).n : 0;
      if (newer) fail(`${newer} revision(s) were recorded after conversion; restoring would discard them. Review manually.`);
    } finally { db.close(); }
  }
  const aside = `${legacy.root}.converted-${Date.now()}`;
  renameSync(legacy.root, aside);
  cpSync(path.join(backupDir, 'vault'), legacy.root, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  for (const suffix of ['', '-wal', '-shm']) rmSync(legacy.statePath + suffix, { force: true });
  cpSync(path.join(backupDir, 'knowledge.sqlite'), legacy.statePath);
  for (const suffix of ['', '-wal', '-shm']) rmSync(path.join(stateRoot, 'registry.sqlite') + suffix, { force: true });
  // The registry sentinel belongs to the removed registry.
  rmSync(path.join(stateRoot, 'registry.id'), { force: true });
  log(`Restored ${legacy.root} and ${legacy.statePath} from ${backupDir}. The converted vault was kept at ${aside}.`);
  log('Restore the previous plugin config with `openclaw config set plugins.entries.knowledge.config` using legacy-config.json.');
}

function backupDatabase(legacy, backupDir) {
  const db = new DatabaseSync(legacy.statePath, { readOnly: true });
  return sqliteBackup(db, path.join(backupDir, 'knowledge.sqlite')).finally(() => db.close());
}
function inventory(legacy) {
  const files = {};
  for (const file of readdirSync(legacy.root, { recursive: true })) {
    const full = path.join(legacy.root, String(file));
    if (String(file).split(path.sep)[0] === '.git' || !statSync(full).isFile()) continue;
    files[String(file)] = sha(readFileSync(full));
  }
  const db = new DatabaseSync(legacy.statePath, { readOnly: true });
  try {
    const counts = Object.fromEntries(['mutations', 'observations', 'history', 'git_jobs', 'git_files'].map(t => [t, db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n]));
    return { at: new Date().toISOString(), files, counts };
  } finally { db.close(); }
}
function atomicWrite(file, text) {
  const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o600;
  const tmp = `${file}.${randomUUID()}.tmp`, fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
  const dir = openSync(path.dirname(file), constants.O_RDONLY); try { fsyncSync(dir); } finally { closeSync(dir); }
}
function openRegistry() {
  const registry = new StoreRegistry(stateRoot, { converting: true });
  return { conversionAndClose() { try { return registry.conversion(); } finally { registry.close(); } } };
}
function setJournal(value) {
  const registry = new StoreRegistry(stateRoot, { converting: true });
  try { registry.conversion(value); } finally { registry.close(); }
}
