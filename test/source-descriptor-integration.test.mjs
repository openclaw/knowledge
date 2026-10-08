import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, rmdir, link, symlink, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse, stringify } from 'yaml';
import { SampleVault, digest } from '../dist/vault.js';
import { fileStamp } from '../dist/evidence-files.js';
import { describeSource, compactEvidence } from '../dist/source-descriptors.js';
import { encodeRecordEvidence, hydrateMetadata, readSourceDescriptor } from '../dist/source-records.js';
import { KnowledgeStorage } from '../dist/storage.js';
import { inspectRecord } from '../dist/inspection.js';
import { SqliteIdentityStore } from '../dist/identity-store.js';
import { GitUnavailable } from '../dist/git-history.js';
import { createVault, plainAccess } from './support.mjs';

// Keep every publication local to the fixture, without invoking Git or workers.
const noGit = { checkpoint() { throw new GitUnavailable('Git deliberately disabled in descriptor tests.'); } };
const frontmatter = raw => parse(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw)[1]);
const draft = (title, attachments = []) => ({ requestId: randomUUID(), title, type: 'note', body: title + '\n', attachments });
const edit = (record, fields = {}) => ({ requestId: randomUUID(), id: record.id, expectedRevision: record.revision,
  expectedHash: record.hash, title: record.title, body: record.body, ...fields });

// Temporary stores use the real storage journal and scoped vault reader.
async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'knowledge-descriptor-integration-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const f = await createVault(base), store = new SqliteIdentityStore(f.config.statePath);
  const access = plainAccess(), scoped = path.join(f.root, 'private');
  const storage = hook => new KnowledgeStorage(f.config, store, hook, noGit);
  return { ...f, base, store, access, scoped, storage, writer: storage(),
    read: relative => readFile(path.join(scoped, relative), 'utf8') };
}

// Retain predictable originals; distinct origins never rely on random hashes.
async function original(root, name = 'meeting') {
  const text = name + ' first line\n' + name + ' second line\n';
  const evidence = { path: 'artifacts/' + name + '.txt', sha256: digest(text), filename: name + '.txt',
    mediaType: 'text/plain', size: Buffer.byteLength(text), attribution: 'Recorder original' };
  await mkdir(path.join(root, 'artifacts'), { recursive: true });
  await writeFile(path.join(root, evidence.path), text);
  return evidence;
}

// Authored records let tests exercise raw YAML and the scanner independently.
function authored(evidence, overrides = {}, body = 'Exact authored body.\n') {
  const metadata = { format: 'knowledge-record-v1', id: 'descriptor_note', revision: 1, kind: 'page', type: 'note',
    title: 'Descriptor note', scope: { visibility: 'private' }, recorded_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z', lifecycle: 'active', evidence: [evidence], ...overrides };
  const raw = '---\n' + stringify(metadata, { aliasDuplicateObjects: false }) + '---\n' + body;
  return { id: metadata.id, title: metadata.title, revision: metadata.revision, kind: 'page', type: 'note',
    lifecycle: 'active', path: 'notes/descriptor.md', valid: true, metadata, raw, body, hash: digest(raw) };
}

// Install only a compact record and its immutable descriptor in this partition.
async function install(root, evidence, overrides = {}) {
  const source = describeSource(evidence), record = authored({ source: source.id }, overrides);
  await mkdir(path.join(root, 'artifacts/sources'), { recursive: true });
  await mkdir(path.join(root, 'notes'), { recursive: true });
  await writeFile(path.join(root, source.path), source.raw);
  await writeFile(path.join(root, record.path), record.raw);
  return { source, record };
}

// Return the actual journal accepted plan, not an inferred list of files.
function planFor(f, requestId) {
  return f.store.withDatabase(db => JSON.parse(db.prepare('SELECT plan FROM mutations WHERE request=?').get(requestId).plan));
}

// Read the fully hydrated domain record through the same scope as publication.
async function recordFor(f, id) {
  return f.writer.run(f.access, async vault => (await vault.scan()).records.find(record => record.id === id));
}

test('same source deduplicates across records and a multi-source batch retains every descriptor', async t => {
  const f = await fixture(t), shared = await original(f.scoped), other = await original(f.scoped, 'other');
  const source = describeSource(shared), secondSource = describeSource(other);
  const first = await f.writer.save(draft('First', [shared]), f.access, 'agent');
  const sourceStamp = fileStamp(f.scoped, source.path);
  const second = await f.writer.save(draft('Second', [shared]), f.access, 'agent');
  assert.equal(fileStamp(f.scoped, source.path), sourceStamp, 'reuse does not rewrite immutable bytes');
  for (const receipt of [first, second]) {
    assert.equal(receipt.state, 'published');
    assert.deepEqual(frontmatter(await f.read(receipt.path)).evidence, [{ source: source.id }]);
    assert.deepEqual((await recordFor(f, receipt.id)).metadata.evidence, [{ ...shared, source: source.id }]);
    const api = await f.writer.run(f.access, vault => inspectRecord(vault, { id: receipt.id, includeMetadata: true, includeEvidence: true }));
    assert.deepEqual(api.record.metadata.evidence, [{ ...shared, source: source.id }]);
    assert.equal(api.evidence[0].verified, true);
  }
  const fingerprint = await f.writer.run(f.access, async vault => (await vault.scan()).ontology.fingerprint);
  const input = { requestId: randomUUID(), expectedVaultId: f.config.vaultId, expectedOntologyFingerprint: fingerprint,
    items: [shared, shared, other].map((evidence, index) => ({ key: 'note' + index, kind: 'page',
      input: { title: 'Batch ' + index, type: 'note', body: 'Batch body\n', attachments: [evidence] } })) };
  const batch = await f.writer.batch(input, f.access, 'agent'), plan = planFor(f, input.requestId);
  assert.equal(batch.state, 'published');
  assert.equal(batch.items.length, 3);
  assert.deepEqual(Object.keys(plan.descriptors).sort(), [source.path, secondSource.path].sort());
  assert.deepEqual((await readdir(path.join(f.scoped, 'artifacts/sources'))).sort(), [source.id + '.json', secondSource.id + '.json'].sort());
  assert.equal(plan.changes.some(change => change.path === 'private/' + source.path), false, 'reused descriptor is a replay dependency, not a write');
  for (const [index, item] of batch.items.entries()) {
    const expected = index === 2 ? secondSource : source;
    assert.deepEqual(frontmatter(await f.read(item.path)).evidence, [{ source: expected.id }]);
    assert.equal((await recordFor(f, item.id)).metadata.evidence[0].source, expected.id);
    assert.equal(await f.read(expected.path), expected.raw);
    assert.equal(digest(await f.read(expected.path)), expected.id);
  }
});

test('encoding preserves exact body, unknown YAML, and all supported annotation evidence fields', async t => {
  const f = await fixture(t), evidence = await original(f.scoped);
  const passage = { ...evidence, start_line: 1, end_line: 1, quote: 'meeting first line' };
  const basis = { basis: 'Retained passage', evidence: [passage] };
  const body = '\r\n# Exact Ω body  \r\n\r\n---\r\nNo trailing newline';
  const record = authored(passage, { custom: { evidence: [{ untouched: true }], nested: [1, 'two'] },
    attribution_confidence: { level: 'high', ...basis },
    identity: { status: 'partial', context: 'Keep this wording.', candidates: [{ id: 'candidate_person', ...basis }] },
    continuity: [{ id: 'previous_record', relation: 'updates', ...basis }] }, body);
  record.raw = record.raw.replace('custom:\n', '# authored comment\ncustom:\n').replace('title: Descriptor note', 'title: "Descriptor note"');
  const before = structuredClone(record), encoded = encodeRecordEvidence(record, () => { throw Error('Unexpected legacy descriptor read'); });
  assert.deepEqual(record, before, 'encoding does not mutate the caller');
  assert.equal(encoded.record.body, body);
  assert.equal(encoded.record.raw.slice(encoded.record.raw.indexOf('\n---\n') + 5), body);
  assert.ok(encoded.record.raw.includes('# authored comment\ncustom:\n'));
  assert.ok(encoded.record.raw.includes('title: "Descriptor note"'));
  const rawMetadata = frontmatter(encoded.record.raw), source = describeSource(evidence);
  assert.deepEqual(rawMetadata.custom, record.metadata.custom);
  assert.deepEqual(Object.keys(encoded.descriptors), [source.path]);
  const citation = { source: source.id, start_line: 1, end_line: 1, quote: passage.quote };
  for (const citations of [rawMetadata.evidence, rawMetadata.attribution_confidence.evidence,
    rawMetadata.identity.candidates[0].evidence, rawMetadata.continuity[0].evidence]) assert.deepEqual(citations, [citation]);
  const hydrated = hydrateMetadata(rawMetadata, relative => encoded.descriptors[relative]);
  assert.deepEqual(hydrated.evidence, [{ ...passage, source: source.id }]);
  assert.deepEqual(hydrated.custom, record.metadata.custom);
  assert.equal(encoded.record.hash, digest(encoded.record.raw));
});

test('descriptor tamper, deletion and reappearance invalidate whole-scan and parsed-file caches without touching the record', async t => {
  const f = await fixture(t), evidence = await original(f.scoped), { source, record } = await install(f.scoped, evidence);
  const cache = {}, vault = new SampleVault(f.scoped, f.access.scope, false, undefined, cache);
  const recordStamp = fileStamp(f.scoped, record.path), descriptorFile = path.join(f.scoped, source.path);
  // Advance the cache clock beyond the filesystem race window instead of sleeping.
  t.mock.method(Date, 'now', () => 4102444800000);
  const initial = await vault.scan();
  assert.equal(initial.records[0].valid, true);
  assert.strictEqual(await vault.scan(), initial, 'whole-scan cache is genuinely warm');
  assert.ok(cache.files.get(record.path).record, 'parsed-file cache is genuinely warm');
  const initialTree = cache.entry.tree;
  await writeFile(descriptorFile, source.raw.replace('Recorder original', 'Recorder tampered'));
  const changed = await vault.scan();
  assert.notStrictEqual(changed, initial);
  assert.equal(cache.entry.tree, initialTree, 'descriptor-only mutation is outside the record tree stamp');
  assert.equal(changed.records.length, 0);
  assert.ok(changed.issues.some(issue => issue.path === record.path && issue.code === 'invalid-record'));
  assert.equal(cache.files.get(record.path).record, undefined, 'stale parsed evidence was discarded');
  await writeFile(descriptorFile, source.raw);
  const restored = await vault.scan();
  assert.equal(restored.records[0].valid, true);
  assert.strictEqual(await vault.scan(), restored);
  await rm(descriptorFile);
  const missing = await vault.scan();
  assert.equal(missing.records.length, 0);
  assert.ok(missing.issues.some(issue => issue.code === 'invalid-record'));
  assert.equal(cache.files.has(record.path), false, 'missing dependencies must not create settled negative cache entries');
  await writeFile(descriptorFile, source.raw);
  const reappeared = await vault.scan();
  assert.equal(reappeared.records[0].valid, true);
  assert.deepEqual(reappeared.records[0].metadata.evidence, [{ ...evidence, source: source.id }]);
  assert.strictEqual(await vault.scan(), reappeared);
  assert.equal(fileStamp(f.scoped, record.path), recordStamp);
});

test('scope is checked before hydration and a descriptor cannot resolve from a sibling partition', async t => {
  const f = await fixture(t), evidence = await original(f.scoped), source = describeSource(evidence);
  await install(f.scoped, evidence, { scope: { visibility: 'conversation', sessionId: '11111111-1111-1111-1111-111111111111' } });
  await rm(path.join(f.scoped, source.path));
  const cache = {}, vault = new SampleVault(f.scoped, f.access.scope, false, undefined, cache);
  t.mock.method(Date, 'now', () => 4102444800000);
  const wrong = await vault.scan();
  assert.equal(wrong.records.length, 0);
  assert.match(wrong.issues[0].message, /scope.*does not match/);
  assert.equal(cache.files.get('notes/descriptor.md').descriptors.size, 0, 'no descriptor was consulted for a foreign-scope record');
  assert.equal(cache.entry.evidence.size, 0);
  // A correctly scoped record still cannot borrow an identically named sibling sidecar.
  const conversation = path.join(f.root, 'conversations/22222222-2222-2222-2222-222222222222');
  await mkdir(path.join(conversation, 'artifacts/sources'), { recursive: true });
  await writeFile(path.join(conversation, source.path), source.raw);
  await writeFile(path.join(f.scoped, 'notes/descriptor.md'), authored({ source: source.id }).raw);
  const unavailable = await vault.scan();
  assert.equal(unavailable.records.length, 0);
  assert.ok(unavailable.issues.some(issue => issue.code === 'invalid-record'));
  await writeFile(path.join(f.scoped, source.path), source.raw);
  assert.equal((await vault.scan()).records[0].valid, true);
});

test('guarded descriptor reads reject hard links, file symlinks and directory symlinks', async t => {
  const f = await fixture(t), evidence = await original(f.scoped), { source } = await install(f.scoped, evidence);
  const target = path.join(f.scoped, source.path), outside = path.join(f.base, 'descriptor.json');
  await writeFile(outside, source.raw);
  assert.equal(readSourceDescriptor(f.scoped, source.path), source.raw);
  // Each unsafe replacement has identical bytes: rejection must come from the guard.
  for (const kind of ['hard', 'symbolic']) {
    await rm(target);
    if (kind === 'hard') await link(outside, target); else await symlink(outside, target);
    assert.throws(() => readSourceDescriptor(f.scoped, source.path), /unsafe|symbolic|link/i);
    const data = await new SampleVault(f.scoped, f.access.scope).scan();
    assert.equal(data.records.length, 0);
    assert.ok(data.issues.some(issue => issue.code === 'invalid-record'));
  }
  await rm(target);
  await rmdir(path.dirname(target));
  const elsewhere = path.join(f.base, 'sources'); await mkdir(elsewhere);
  await writeFile(path.join(elsewhere, source.id + '.json'), source.raw);
  await symlink(elsewhere, path.dirname(target));
  assert.throws(() => readSourceDescriptor(f.scoped, source.path), /unsafe|symbolic|link/i);
  assert.throws(() => readSourceDescriptor(f.scoped, 'artifacts/sources/../../descriptor.json'), /Invalid source descriptor path/);
  assert.equal(await readFile(outside, 'utf8'), source.raw);
});

test('interrupted publication fences a reused descriptor and refuses completion without overwriting tampering', async t => {
  const f = await fixture(t), evidence = await original(f.scoped), source = describeSource(evidence);
  const created = await f.writer.save(draft('Existing record', [evidence]), f.access, 'agent');
  const record = await recordFor(f, created.id), originalRaw = await f.read(created.path);
  const input = edit(record, { body: 'Proposed replacement body\n' });
  const interrupted = f.storage(stage => { if (stage === 'after-accept') throw Error('Intentional interruption'); });
  await assert.rejects(interrupted.save(input, f.access, 'agent'), /Intentional interruption/);
  const plan = planFor(f, input.requestId);
  assert.equal(plan.descriptors[source.path], source.raw);
  assert.equal(plan.changes.some(change => change.path === 'private/' + source.path), false);
  const manifestBefore = await readFile(path.join(f.root, 'vault.json'), 'utf8');
  const tampered = source.raw.replace('Recorder original', 'Recorder tampered');
  await writeFile(path.join(f.scoped, source.path), tampered);
  const resumed = f.storage().resume(f.access, input.requestId);
  assert.equal(resumed.state, 'conflict');
  assert.equal(await f.read(source.path), tampered, 'the immutable-source conflict is never repaired by overwriting it');
  assert.equal(await f.read(created.path), originalRaw, 'replay rejects the dependency before installing the proposed record');
  assert.equal(await readFile(path.join(f.root, 'vault.json'), 'utf8'), manifestBefore);
  assert.deepEqual(f.storage().resume(f.access, input.requestId), resumed);
  await assert.rejects(f.writer.run(f.access, vault => vault.scan()), /publication pending or conflicted/i);
});

test('an unrelated page edit preserves source-origin and citation-specific attribution separately', async t => {
  const f = await fixture(t), origin = await original(f.scoped), source = describeSource(origin);
  const citationEvidence = { ...origin, attribution: 'Speaker identified in passage', start_line: 2, end_line: 2, quote: 'meeting second line' };
  const { citation } = compactEvidence(citationEvidence, origin);
  await mkdir(path.join(f.scoped, 'artifacts/sources'), { recursive: true });
  await mkdir(path.join(f.scoped, 'notes'), { recursive: true });
  await writeFile(path.join(f.scoped, source.path), source.raw);
  const authoredRecord = authored(citation);
  await writeFile(path.join(f.scoped, authoredRecord.path), authoredRecord.raw);
  const before = await recordFor(f, authoredRecord.id), descriptorStamp = fileStamp(f.scoped, source.path);
  assert.deepEqual(before.metadata.evidence, [{ ...citationEvidence, source: source.id }]);
  const saved = await f.writer.save(edit(before, { title: 'Unrelated title edit' }), f.access, 'agent');
  assert.equal(saved.state, 'published');
  assert.deepEqual(frontmatter(await f.read(saved.path)).evidence, [citation]);
  assert.equal(await f.read(source.path), source.raw);
  assert.equal(fileStamp(f.scoped, source.path), descriptorStamp);
  assert.equal(JSON.parse(await f.read(source.path)).attribution, 'Recorder original');
  const after = await recordFor(f, saved.id);
  assert.deepEqual(after.metadata.evidence, before.metadata.evidence);
  assert.equal(after.body, before.body);
  assert.deepEqual(await readdir(path.join(f.scoped, 'artifacts/sources')), [source.id + '.json']);
  assert.equal((await stat(path.join(f.scoped, source.path))).nlink, 1);
});
