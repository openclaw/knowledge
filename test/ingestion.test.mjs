import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Check } from 'typebox/value';
import { KnowledgeStorage } from '../dist/storage.js';
import { Publisher } from '../dist/publisher.js';
import { SqliteIdentityStore } from '../dist/identity-store.js';
import { createKnowledgeService } from '../dist/service.js';
import { authorizeVault } from '../dist/access.js';
import { contract } from '../dist/contract.js';

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'knowledge-write-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'vault'); await mkdir(root); await mkdir(path.join(root, 'private'));
  const manifest = { format: 'knowledge-vault-v1', vaultId: randomUUID(), agentId: 'main', generation: 0, publicationId: randomUUID() };
  await writeFile(path.join(root, 'vault.json'), JSON.stringify(manifest));
  const config = { root, statePath: path.join(base, 'state.sqlite'), agentId: 'main', vaultId: manifest.vaultId, publicationId: manifest.publicationId, operatorRead: true, writesEnabled: true };
  let entry = { sessionId: randomUUID(), chatType: 'direct' };
  const api = { pluginConfig: { vault: config }, runtime: { agent: { session: { getSessionEntry: () => entry } } } };
  const owner = { source: 'tool', api, tool: { agentId: 'main', sessionId: entry.sessionId, sessionKey: 'agent:main:write-test', senderIsOwner: true, assertInvocationCurrent() {} } };
  const operator = { source: 'session-action', api, action: { client: { connId: 'test', scopes: ['operator.write'] } } };
  const store = new SqliteIdentityStore(config.statePath), service = createKnowledgeService(api);
  const access = () => authorizeVault(owner, 'main', true, true);
  return { base, root, config, manifest, api, owner, operator, store, service, access, setEntry: v => { entry = v; } };
}
const draft = () => ({ requestId: randomUUID(), title: 'Publication test', type: 'note', body: 'Authored text.\n' });
const edit = (record, fields = {}) => ({ requestId: randomUUID(), id: record.id, expectedRevision: record.revision, expectedHash: record.hash, title: record.title, body: record.body, ...fields });

async function batchFixture(t) {
  const f = await fixture(t);
  const original = await f.service.attach({ requestId: randomUUID(), filename: 'meeting.txt', attribution: 'Recorder export', offset: 0, data: Buffer.from('Morgan attended the review.\nMorgan will send the report on Friday.').toString('base64'), final: true }, f.owner);
  const fingerprint = (await f.service.ontology({}, f.owner)).fingerprint;
  const input = { requestId: randomUUID(), expectedVaultId: f.config.vaultId, expectedOntologyFingerprint: fingerprint,
    source: { provider: 'trial', key: 'meeting-1', sha256: original.evidence.sha256 },
    items: [
      { key: 'meeting', kind: 'page', input: { title: 'Review', type: 'meeting', body: 'Review with [[@morgan|Morgan]]. See [[@meeting|source]].', attachments: [original.evidence] } },
      { key: 'morgan', kind: 'page', input: { title: 'Morgan', type: 'person', body: 'Attended [[@meeting|Review]].' } },
      { key: 'action', kind: 'claim', input: { title: 'Send report', body: 'Morgan offered to send the report Friday.', claim_kind: 'commitment', assertion_origin: 'source', attribution: 'Morgan, recorder line 2', evidence: [{ ...original.evidence, start_line: 2, end_line: 2 }], owner: '@morgan', source_page: '@meeting', dependencies: ['@meeting'], entities: ['@morgan'] } },
      { key: 'attendance', kind: 'relationship', input: { title: 'Attended review', body: 'Morgan attended.', from: '@morgan', to: '@meeting', label: 'attended', attribution: 'Recorder line 1', evidence: [{ ...original.evidence, start_line: 1, end_line: 1 }] } },
    ] };
  assert.ok(Check(contract.operations.publish_batch.input, input));
  return { ...f, input, original };
}
const verifyInput = receipt => ({ records: receipt.items.map(item => ({ id: item.id, expectedHash: item.hash, expectedRevision: item.revision })) });

test('one batch resolves forward references, self-links, claims/edges; one bounded verification checks all outputs', async t => {
  const f = await batchFixture(t), receipt = await f.service.publish_batch(f.input, f.owner);
  assert.ok(Check(contract.operations.publish_batch.output, receipt));
  assert.equal(receipt.state, 'published'); assert.equal(receipt.items.length, 4);
  const ids = Object.fromEntries(receipt.items.map(r => [r.key, r.id]));
  const action = (await f.service.record({ id: ids.action, includeMetadata: true }, f.owner)).record;
  assert.equal(action.metadata.owner, ids.morgan); assert.equal(action.metadata.source_page, ids.meeting);
  const meeting = await f.service.record({ id: ids.meeting }, f.owner);
  assert.match(meeting.record.body, new RegExp(ids.morgan));
  assert.ok(meeting.links.every(l => l.status === 'resolved'));
  assert.equal((await f.service.history({}, f.owner)).mutations.length, 1);
  assert.equal(JSON.parse(await readFile(path.join(f.root, 'vault.json'), 'utf8')).generation, 1);
  const verified = await f.service.verify(verifyInput(receipt), f.owner);
  assert.ok(Check(contract.operations.verify.output, verified));
  assert.equal(verified.passed, 4); assert.equal(verified.failed, 0); assert.equal(verified.index, 'ready');
  assert.ok(Buffer.byteLength(JSON.stringify(verified)) < 1200);
  assert.deepEqual(await createKnowledgeService(f.api).publish_batch(f.input, f.owner), receipt);
  await assert.rejects(f.service.publish_batch({ ...f.input, items: f.input.items.slice(0, 2) }, f.owner), /different payload/);
  const recovery = await f.service.mutation({ requestId: receipt.requestId, includeFiles: false }, f.owner);
  assert.ok(Check(contract.operations.mutation.output, recovery));
  assert.equal(recovery.files.length, 0); assert.equal(recovery.totalFiles, 4);
  const first = await f.service.mutation({ requestId: receipt.requestId }, f.owner);
  assert.equal(first.files.length, 3); assert.equal(first.nextOffset, 3);
  const last = await f.service.mutation({ requestId: receipt.requestId, offset: first.nextOffset }, f.owner);
  assert.equal(last.files.length, 1); assert.equal(last.nextOffset, null);
  await assert.rejects(f.service.publish_batch({ ...f.input, requestId: randomUUID() }, f.operator), /chat and agent/);
});

for (const stage of ['after-accept', 'after-install:private/people/', 'after-install:private/claims/', 'before-receipt']) test(`batch interruption ${stage} resumes once with no partial reads`, async t => {
  const f = await batchFixture(t), storage = new KnowledgeStorage(f.config, f.store, where => { if (where.startsWith(stage)) throw Error('simulated interruption'); });
  await assert.rejects(storage.batch(f.input, f.access(), 'agent'), /simulated interruption/);
  await assert.rejects(f.service.records({}, f.owner), /publication|identity/);
  const status = await f.service.source_check(f.input.source, f.owner);
  assert.equal(status.state, 'unchanged'); assert.equal(status.receipt.state, 'accepted');
  const receipt = await createKnowledgeService(f.api).publish_batch(f.input, f.owner);
  assert.equal(receipt.state, 'published');
  assert.equal((await f.service.records({}, f.owner)).total, 4);
  assert.deepEqual(await f.service.resume({ requestId: f.input.requestId }, f.owner), receipt);
});

test('prevalidation rejects a late invalid item without accepting any records', async t => {
  const f = await batchFixture(t);
  const bad = structuredClone(f.input); bad.items[3].input.label = 'not_declared';
  await assert.rejects(f.service.publish_batch(bad, f.owner), /valid type/);
  assert.equal((await f.service.records({}, f.owner)).total, 0);
  assert.equal((await f.service.mutation({ requestId: bad.requestId, includeFiles: false }, f.owner)).receipt, null);
  bad.items[3].input.label = 'attended'; bad.items[2].input.owner = '@unknown';
  await assert.rejects(f.service.publish_batch(bad, f.owner), /Unknown local/);
  bad.items[2].input.owner = '@morgan'; bad.items[3].input.from = '@action';
  await assert.rejects(f.service.publish_batch(bad, f.owner), /invalid-reference/);
  bad.items[3].input.from = '@morgan'; bad.source.sha256 = 'a'.repeat(64);
  await assert.rejects(f.service.publish_batch(bad, f.owner), /hash must match/);
  assert.equal((await f.service.records({}, f.owner)).total, 0);
});

test('source ID/hash receipts survive replacement; changed bytes require reconciliation, unchanged never republish', async t => {
  const f = await batchFixture(t);
  assert.equal((await f.service.source_check(f.input.source, f.owner)).state, 'missing');
  const first = await f.service.publish_batch(f.input, f.owner);
  const service = createKnowledgeService(f.api);
  const checked = await service.source_check(f.input.source, f.owner);
  assert.ok(Check(contract.operations.source_check.output, checked));
  assert.equal(checked.state, 'unchanged'); assert.deepEqual(checked.receipt, first);
  assert.deepEqual(await service.publish_batch({ ...f.input, requestId: randomUUID() }, f.owner), first);
  const revised = await service.attach({ requestId: randomUUID(), filename: 'revised.txt', attribution: 'Revised export', offset: 0, data: Buffer.from('Updated original').toString('base64'), final: true }, f.owner);
  const source = { ...f.input.source, sha256: revised.evidence.sha256 };
  assert.equal((await service.source_check(source, f.owner)).state, 'changed');
  const meeting = first.items.find(i => i.key === 'meeting');
  const input = { ...f.input, requestId: randomUUID(), source, items: [{ key: 'meeting', kind: 'page', input: {
    id: meeting.id, expectedRevision: meeting.revision, expectedHash: meeting.hash, title: 'Review', body: 'Reconciled revised source', attachments: [revised.evidence],
  } }] };
  await assert.rejects(service.publish_batch(input, f.owner), /Source changed/);
  const second = await service.publish_batch({ ...input, expectedPreviousRequestId: first.requestId }, f.owner);
  assert.equal(second.items[0].id, meeting.id); assert.equal(second.items[0].revision, 2);
  assert.equal((await service.records({}, f.owner)).total, 4);
  // An earlier export returning does not silently return a receipt from the wrong version.
  assert.equal((await service.source_check(f.input.source, f.owner)).state, 'changed');
  const beforeWithdraw = second.items[0];
  await service.withdraw({ requestId: randomUUID(), id: beforeWithdraw.id, expectedRevision: beforeWithdraw.revision, expectedHash: beforeWithdraw.hash, reason: 'Explicit test withdrawal' }, f.owner);
  assert.deepEqual(await service.publish_batch({ ...input, requestId: randomUUID() }, f.owner), second);
  assert.equal((await service.verify(verifyInput(second), f.owner)).failed, 1, 'Unchanged original does not resurrect withdrawn outputs');
});

test('verification catches evidence damage, broken links, changed revisions and explicit absent owner/date expectations', async t => {
  const f = await batchFixture(t), receipt = await f.service.publish_batch(f.input, f.owner);
  const input = verifyInput(receipt), action = receipt.items.find(i => i.key === 'action'), person = receipt.items.find(i => i.key === 'morgan');
  const exp = input.records.find(r => r.id === action.id); exp.owner = null; exp.due_at = '2026-09-25';
  const mismatch = await f.service.verify({ ...input, limit: 1 }, f.owner);
  assert.equal(mismatch.failed, 1); assert.equal(mismatch.totalProblems, 2); assert.equal(mismatch.nextOffset, 1);
  const next = await f.service.verify({ ...input, limit: 1, offset: 1, snapshot: mismatch.snapshot }, f.owner);
  assert.equal(next.problems[0].code, 'due_at-mismatch');
  await f.service.save_page({ requestId: randomUUID(), id: person.id, expectedHash: person.hash, expectedRevision: person.revision, title: 'Morgan', body: 'Broken [[unavailable-target]].' }, f.owner);
  await assert.rejects(f.service.verify({ ...input, offset: 1, snapshot: mismatch.snapshot }, f.owner), /snapshot changed/);
  const changed = await f.service.verify(input, f.owner);
  assert.ok(changed.problems.some(p => p.code === 'missing-link'));
  assert.ok(changed.problems.some(p => p.code === 'hash-mismatch'));
  await writeFile(path.join(f.root, 'private', f.original.evidence.path), 'Tampered original');
  const invalid = await f.service.verify(input, f.owner);
  assert.ok(invalid.problems.some(p => p.code === 'invalid-evidence'));
  const missing = await f.service.verify({ records: [{ id: randomUUID() }] }, f.owner);
  assert.equal(missing.failed, 1); assert.equal(missing.problems[0].code, 'unavailable');
});

test('verification checks page occurrence fields and claim dates consistently with record inspection', async t => {
  const f = await batchFixture(t);
  const occurredAt = '2026-09-24T15:59:47.098Z';
  f.input.items[0].input.fields = { occurred_at: occurredAt };
  Object.assign(f.input.items[2].input, { occurred_at: '2026-09-24', due_at: '2026-09-25' });
  const receipt = await f.service.publish_batch(f.input, f.owner);
  const ids = Object.fromEntries(receipt.items.map(r => [r.key, r.id]));
  const meeting = await f.service.record({ id: ids.meeting, view: 'summary' }, f.owner);
  assert.equal(meeting.record.occurredAt, occurredAt);
  const records = [
    { id: ids.meeting, occurred_at: meeting.record.occurredAt, owner: null, due_at: null },
    { id: ids.action, occurred_at: '2026-09-24', due_at: '2026-09-25', owner: ids.morgan },
    { id: ids.morgan, occurred_at: null, owner: null, due_at: null },
  ];
  assert.equal((await f.service.verify({ records }, f.owner)).passed, 3);
  for (const expected of [null, '2026-09-23']) {
    const checked = await f.service.verify({ records: [{ id: ids.meeting, occurred_at: expected }] }, f.owner);
    assert.equal(checked.failed, 1);
    assert.deepEqual(checked.problems.map(p => p.code), ['occurred_at-mismatch']);
  }
});

test('group scope cannot discover private source receipts or verification content', async t => {
  const f = await batchFixture(t), receipt = await f.service.publish_batch(f.input, f.owner);
  f.setEntry({ sessionId: f.owner.tool.sessionId, chatType: 'group' });
  const source = await f.service.source_check(f.input.source, f.owner);
  assert.equal(source.state, 'missing'); assert.equal(source.receipt, null);
  const checked = await f.service.verify(verifyInput(receipt), f.owner);
  assert.equal(checked.failed, 4); assert.ok(checked.problems.every(p => p.code === 'unavailable'));
  assert.ok(!JSON.stringify(checked).includes('Morgan'));
});

test('batch edits retain external changes on conflict and cannot publish partially', async t => {
  const f = await batchFixture(t), first = await f.service.publish_batch(f.input, f.owner);
  const person = first.items.find(i => i.key === 'morgan'), meeting = first.items.find(i => i.key === 'meeting');
  const editBatch = { requestId: randomUUID(), expectedVaultId: f.config.vaultId, expectedOntologyFingerprint: f.input.expectedOntologyFingerprint,
    items: [{ key: 'person', kind: 'page', input: { id: person.id, expectedHash: person.hash, expectedRevision: person.revision, title: 'Morgan', body: 'Proposed updated profile' } },
      { key: 'meeting', kind: 'page', input: { id: meeting.id, expectedHash: meeting.hash, expectedRevision: meeting.revision, title: 'Review', body: 'Proposed updated review' } }] };
  const filename = path.join(f.root, 'private', person.path);
  const before = await readFile(filename, 'utf8');
  const storage = new KnowledgeStorage(f.config, f.store, stage => { if (stage === 'after-accept') writeFileSync(filename, before.replace('Attended', 'External authored change: attended')); });
  const receipt = await storage.batch(editBatch, f.access(), 'agent');
  assert.equal(receipt.state, 'conflict');
  assert.match(await readFile(filename, 'utf8'), /External authored change/);
  await assert.rejects(f.service.records({}, f.owner), /publication/);
  assert.equal((await f.service.resume({ requestId: editBatch.requestId }, f.owner)).state, 'conflict');
});

test('evidence changed before acceptance rejects the entire batch', async t => {
  const f = await batchFixture(t);
  const storage = new KnowledgeStorage(f.config, f.store, stage => { if (stage === 'before-accept') writeFileSync(path.join(f.root, 'private', f.original.evidence.path), 'Changed evidence'); });
  await assert.rejects(storage.batch(f.input, f.access(), 'agent'));
  assert.equal((await f.service.history({}, f.owner)).mutations.length, 0);
  assert.equal((await f.service.records({}, f.owner)).total, 0);
});

test('summary reads exclude related assertion bodies but explicit evidence reads keep UI context', async t => {
  const f = await batchFixture(t);
  f.input.items.push({ key: 'other', kind: 'claim', input: { title: 'Related commitment', body: 'A long related assertion '.repeat(300), claim_kind: 'commitment', assertion_origin: 'source', attribution: 'Trial source', evidence: [f.original.evidence], continuity: [{ id: '@action', relation: 'reaffirms', basis: 'Synthetic same statement', evidence: [f.original.evidence] }] } });
  const receipt = await f.service.publish_batch(f.input, f.owner), action = receipt.items.find(i => i.key === 'action');
  const summary = await f.service.record({ id: action.id, view: 'summary' }, f.owner);
  assert.equal(summary.relatedStatements, undefined); assert.equal(summary.record.body, undefined);
  assert.ok(JSON.stringify(summary).length < 2500);
  const expanded = await f.service.record({ id: action.id, view: 'summary', includeEvidence: true, maxEvidenceChars: 100 }, f.owner);
  assert.equal(expanded.relatedStatements.length, 1);
});

test('verification reports unavailable index instead of a false pass', async t => {
  const f = await batchFixture(t), receipt = await f.service.publish_batch(f.input, f.owner);
  // A malformed projection is not authoritative data; verification must report failure.
  f.store.withDatabase(db => db.exec('CREATE TABLE keyword_state_v1 (wrong TEXT)'));
  const checked = await f.service.verify(verifyInput(receipt), f.owner);
  assert.equal(checked.index, 'unavailable'); assert.equal(checked.failed, 4);
  assert.ok(checked.problems.every(p => p.code === 'index-unavailable'));
});


test('stale page edit prevents acceptance of all batch outputs', async t => {
  const f = await batchFixture(t), receipt = await f.service.publish_batch(f.input, f.owner);
  const person = receipt.items.find(i => i.key === 'morgan');
  await f.service.save_page({ requestId: randomUUID(), id: person.id, expectedHash: person.hash, expectedRevision: person.revision, title: 'Morgan', body: 'Newer authored context' }, f.owner);
  const stale = { requestId: randomUUID(), expectedVaultId: f.config.vaultId, expectedOntologyFingerprint: f.input.expectedOntologyFingerprint, items: [
    { key: 'new', kind: 'page', input: { type: 'note', title: 'Must not publish', body: 'Late validation fails' } },
    { key: 'person', kind: 'page', input: { id: person.id, expectedHash: person.hash, expectedRevision: person.revision, title: 'Morgan', body: 'Stale proposed context' } },
  ] };
  await assert.rejects(f.service.publish_batch(stale, f.owner), /Edit conflict/);
  assert.equal((await f.service.records({}, f.owner)).total, 4);
  assert.equal((await f.service.mutation({ requestId: stale.requestId }, f.owner)).receipt, null);
});
