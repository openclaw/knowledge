import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { KnowledgeStorage } from '../dist/storage.js';
import { SqliteIdentityStore } from '../dist/identity-store.js';
import { GitUnavailable } from '../dist/git-history.js';
import { createVault, plainAccess } from './support.mjs';

const noGit = { checkpoint() { throw new GitUnavailable('Isolated capacity test'); } };
/** Retain large fixture bodies as ordinary external Markdown edits, never production data. */
export async function capacityFixture(t, bytes = 180000) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'knowledge-capacity-'));
  t?.after(() => rm(base, { recursive: true, force: true }));
  const f = await createVault(base), db = new SqliteIdentityStore(f.config.statePath);
  const storage = new KnowledgeStorage(f.config, db, undefined, noGit), access = plainAccess();
  const saved = await storage.save({ requestId: randomUUID(), title: 'Capacity fixture', type: 'concept', body: 'original' }, access, 'agent');
  const file = path.join(f.root, 'private', saved.path), original = await readFile(file, 'utf8');
  const header = original.slice(0, original.length - 'original'.length);
  const unit = 'Capacity needle paragraph with Unicode é.\n';
  const body = unit.repeat(Math.floor((bytes - Buffer.byteLength(header)) / Buffer.byteLength(unit)));
  await writeFile(file, header + body);
  const scan = () => storage.run(access, vault => vault.scan());
  const record = async () => (await scan()).records.find(r => r.id === saved.id);
  return { ...f, base, db, storage, access, saved, file, body, scan, record };
}
