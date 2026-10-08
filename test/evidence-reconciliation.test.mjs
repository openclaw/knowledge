import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Check } from 'typebox/value';
import { parse } from 'yaml';
import { KnowledgeStorage } from '../dist/storage.js';
import { SqliteIdentityStore } from '../dist/identity-store.js';
import { GitUnavailable } from '../dist/git-history.js';
import { ReconcileEvidenceOutput } from '../dist/evidence-reconciliation-contract.js';
import { digest } from '../dist/vault.js';
import { createVault, plainAccess } from './support.mjs';

const noGit = { checkpoint() { throw new GitUnavailable('Disabled in migration fixture'); } };
const meta = raw => parse(/^---\n([\s\S]*?)\n---\n/.exec(raw)[1]);

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'knowledge-source-migration-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const f = await createVault(base), db = new SqliteIdentityStore(f.config.statePath);
  const storage = new KnowledgeStorage(f.config, db, undefined, noGit), access = plainAccess();
  const scoped = path.join(f.root, 'private');
  const scan = () => storage.run(access, vault => vault.scan());
  const record = async id => (await scan()).records.find(r => r.id === id);
  const input = async (id, extra = {}) => {
    const current = await record(id), data = await scan();
    return { requestId: randomUUID(), id, expectedVaultId: f.config.vaultId, expectedRevision: current.revision,
      expectedHash: current.hash, expectedOntologyFingerprint: data.ontology.fingerprint,
      reason: 'Explicit fixture representation review', dryRun: true, representation: 'compact', ...extra };
  };
  return { ...f, db, storage, access, scoped, scan, record, input };
}

async function retained(f, name, text = 'line one\nline two\n', attribution = 'Retained original') {
  const evidence = { path: 'artifacts/' + name + '.txt', sha256: digest(text), attribution };
  await mkdir(path.join(f.scoped, 'artifacts'), { recursive: true });
  await writeFile(path.join(f.scoped, evidence.path), text);
  return evidence;
}
const save = (f, attachments, extra = {}) => f.storage.save({ requestId: randomUUID(), title: 'Person fixture', type: 'person',
  body: '# State\r\nSupported state.\r\n# Timeline\r\nHistorical context.\r\n', attachments, ...extra }, f.access, 'agent');

// Omit only representation identity and mutation bookkeeping for semantic equality.
function semantic(metadata) {
  const value = JSON.parse(JSON.stringify(metadata));
  for (const key of ['revision', 'updated_at', 'evidence_change']) delete value[key];
  const visit = obj => { if (!obj || typeof obj !== 'object') return; if (obj.path && obj.sha256) delete obj.source; Object.values(obj).forEach(visit); };
  visit(value); return value;
}

test('preview is read-only; expanded and compact migrations preserve semantics, authorship, originals and history', async t => {
  const f = await fixture(t), evidence = await retained(f, 'source');
  const saved = await save(f, [evidence]), before = await f.record(saved.id);
  const originals = await readFile(path.join(f.scoped, evidence.path));
  const descriptorsBefore = await readdir(path.join(f.scoped, 'artifacts/sources'));
  const historyBefore = f.storage.history(f.access, { id: saved.id }).entries;
  const previewInput = await f.input(saved.id, { representation: 'expanded' });
  const preview = await f.storage.reconcileEvidence(previewInput, f.access);
  assert.ok(Check(ReconcileEvidenceOutput, preview)); assert.equal(preview.state, 'preview');
  assert.equal((await f.record(saved.id)).hash, before.hash);
  assert.equal(f.storage.history(f.access, { id: saved.id }).entries.length, historyBefore.length);
  assert.deepEqual(await readdir(path.join(f.scoped, 'artifacts/sources')), descriptorsBefore);
  const apply = { ...previewInput, dryRun: false }, expanded = await f.storage.reconcileEvidence(apply, f.access);
  assert.equal(expanded.state, 'published'); assert.ok(Check(ReconcileEvidenceOutput, expanded));
  assert.deepEqual(await f.storage.reconcileEvidence(apply, f.access), expanded);
  const full = await f.record(saved.id); assert.ok(meta(full.raw).evidence[0].path);
  assert.equal(full.body, before.body); assert.deepEqual(semantic(full.metadata), semantic(before.metadata));
  assert.equal(full.writtenByAgentId, 'main', 'representation conversion is not a new author');
  const compact = await f.storage.reconcileEvidence(await f.input(saved.id, { dryRun: false }), f.access);
  assert.equal(compact.revision, before.revision + 2);
  const after = await f.record(saved.id);
  assert.equal(meta(after.raw).evidence[0].path, undefined);
  assert.deepEqual(semantic(after.metadata), semantic(before.metadata)); assert.equal(after.body, before.body);
  assert.deepEqual(await readFile(path.join(f.scoped, evidence.path)), originals);
  assert.deepEqual(await readdir(path.join(f.scoped, 'artifacts/sources')), descriptorsBefore);
  const history = f.storage.history(f.access, { id: saved.id }).entries;
  assert.deepEqual(history.slice(0, 2).map(e => e.provenance), ['conversion', 'conversion']);
  assert.equal(f.storage.revision(f.access, history.at(-1).sequence).raw, before.raw);
});

test('reviewed current set replacement retains annotation support, other records, raw history and source files', async t => {
  const f = await fixture(t), a = await retained(f, 'a'), b = await retained(f, 'b');
  const confidence = { level: 'medium', basis: 'Explicitly supported annotation', evidence: [a] };
  const saved = await save(f, [a, b], { attribution_confidence: confidence });
  const other = await save(f, [b], { title: 'Other person' }), otherBefore = await f.record(other.id);
  const before = await f.record(saved.id), sourcePaths = [a.path, b.path];
  const receipt = await f.storage.reconcileEvidence(await f.input(saved.id, { evidence: [], dryRun: false }), f.access);
  const after = await f.record(saved.id);
  assert.equal(receipt.state, 'published'); assert.equal(after.body, before.body);
  assert.equal(after.metadata.evidence.length, 1); assert.equal(after.metadata.evidence[0].path, a.path);
  assert.deepEqual(after.metadata.attribution_confidence, before.metadata.attribution_confidence);
  assert.equal((await f.record(other.id)).hash, otherBefore.hash);
  for (const p of sourcePaths) assert.ok((await readFile(path.join(f.scoped, p))).length);
  const old = f.storage.history(f.access, { id: saved.id }).entries.at(-1);
  assert.equal(f.storage.revision(f.access, old.sequence).raw, before.raw);
});

test('stale revision/hash, ontology/vault and scope fences reject before mutation', async t => {
  const f = await fixture(t), saved = await save(f, [await retained(f, 'source')]);
  const input = await f.input(saved.id, { dryRun: false }), before = await f.record(saved.id);
  for (const change of [{ expectedRevision: 99 }, { expectedHash: '0'.repeat(64) }, { expectedOntologyFingerprint: '0'.repeat(64) }, { expectedVaultId: randomUUID() }]) {
    await assert.rejects(f.storage.reconcileEvidence({ ...input, ...change }, f.access), /changed|conflict/i);
  }
  await assert.rejects(f.storage.reconcileEvidence(input, plainAccess({ visibility: 'conversation', sessionId: randomUUID() })), /unavailable|scope/i);
  assert.equal((await f.record(saved.id)).hash, before.hash);
  assert.equal(f.db.withDatabase(db => db.prepare('SELECT count(*) AS n FROM mutations').get().n), 1);
});

test('expanded dry run refuses an oversized rollback without discarding compact support', async t => {
  const f = await fixture(t), evidence = await retained(f, 'large', 'line\n'.repeat(120), 'A'.repeat(1000));
  const citations = Array.from({ length: 100 }, (_, n) => ({ ...evidence, start_line: n + 1, end_line: n + 1 }));
  const saved = await save(f, citations), before = await f.record(saved.id);
  await assert.rejects(f.storage.reconcileEvidence(await f.input(saved.id, { representation: 'expanded' }), f.access), /exceeds record limits/);
  assert.equal((await f.record(saved.id)).hash, before.hash); assert.equal(before.metadata.evidence.length, 100);
});

// A preparation dependency must not become a silently recreated immutable file.
test('deleting a reused descriptor before acceptance rejects without publication', async t => {
  const f = await fixture(t), saved = await save(f, [await retained(f, 'race')]);
  const before = await f.record(saved.id), input = await f.input(saved.id, { dryRun: false });
  const descriptor = path.join(f.scoped, 'artifacts/sources', before.metadata.evidence[0].source + '.json');
  const { unlinkSync } = await import('node:fs');
  const writer = new KnowledgeStorage(f.config, f.db, stage => {
    if (stage === 'before-accept') unlinkSync(descriptor);
  }, noGit);
  await assert.rejects(writer.reconcileEvidence(input, f.access), /ENOENT|missing|unavailable/i);
  assert.equal(await readFile(path.join(f.scoped, before.path), 'utf8'), before.raw);
  await assert.rejects(readFile(descriptor), /ENOENT/);
  assert.equal(f.db.withDatabase(db => db.prepare('SELECT count(*) AS n FROM mutations').get().n), 1);
});
