import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { KnowledgeStorage } from '../dist/storage.js';
import { createKnowledgeService } from '../dist/service.js';
import { editBody } from '../dist/body-edit.js';
import { operations } from '../dist/storage-host.js';
import { capacityFixture } from './capacity-support.mjs';
import { plainAccess, hostApi, adopt, toolContext, operatorContext } from './support.mjs';

/** Fresh complete fences for one synthetic active-page edit. */
async function input(f, overrides = {}) {
  const current = await f.record(), data = await f.scan();
  return { requestId: randomUUID(), id: current.id, expectedVaultId: f.config.vaultId, expectedRevision: current.revision,
    expectedHash: current.hash, expectedOntologyFingerprint: data.ontology.fingerprint,
    start: 0, end: 0, replacement: 'Added paragraph.\n', reason: 'Fixture body edit', ...overrides };
}

test('bounded edits grow a page beyond input size, preserve metadata/evidence and replay exactly', async t => {
  const f = await capacityFixture(t), before = await f.record();
  // Unknown YAML/comments and existing evidence remain intact through the normal writer.
  await writeFile(f.file, before.raw.replace('revision:', '# authored comment\ncustom: preserve-me\nrevision:'));
  const baseline = await f.record(), request = await input(f, { replacement: 'b'.repeat(48000) });
  const saved = await f.storage.editBody(request, f.access);
  assert.equal(saved.state, 'published'); const after = await f.record();
  assert.equal(after.body, request.replacement + baseline.body); assert.equal(after.revision, baseline.revision + 1);
  assert.match(after.raw, /# authored comment/); assert.match(after.raw, /custom: preserve-me/);
  assert.deepEqual(after.metadata.evidence, baseline.metadata.evidence); assert.equal(after.metadata.body_change.reason, request.reason);
  assert.deepEqual(await f.storage.editBody(request, f.access), saved);
  await assert.rejects(f.storage.editBody({ ...request, replacement: 'different' }, f.access), /request|payload|intent/i);
  const tail = await input(f, { start: after.body.length, end: after.body.length, replacement: 'tail' });
  await f.storage.editBody(tail, f.access); assert.equal((await f.record()).body, after.body + 'tail');
  const deletion = await input(f, { start: 0, end: 48000, replacement: '' });
  await f.storage.editBody(deletion, f.access); assert.equal((await f.record()).body, baseline.body + 'tail');
});

test('all fences, range, request budget, authority and byte overflow fail before acceptance', async t => {
  const f = await capacityFixture(t, 4999000), request = await input(f);
  const before = await readFile(f.file, 'utf8');
  for (const change of [
    { expectedVaultId: randomUUID() }, { expectedRevision: request.expectedRevision + 1 }, { expectedHash: '0'.repeat(64) },
    { expectedOntologyFingerprint: '0'.repeat(64) }, { end: 9000000 }, { start: 3, end: 2 },
    { replacement: 'x'.repeat(48001) }, { replacement: '\u0000'.repeat(48000) }, { replacement: 'é'.repeat(1000) },
  ]) await assert.rejects(f.storage.editBody({ ...request, requestId: randomUUID(), ...change }, f.access));
  await assert.rejects(f.storage.editBody(request, plainAccess({ visibility: 'conversation', sessionId: 'other-session' })), /unavailable|scope|partition|exist/i);
  await assert.rejects(f.storage.editBody(request, { ...f.access, assertCurrent() { throw Error('revoked'); } }), /revoked/);
  assert.equal(await readFile(f.file, 'utf8'), before);
  assert.equal(f.storage.mutation(f.access, request.requestId).receipt, null);
});

test('interrupted large edits replay once; external changes before acceptance are never overwritten', async t => {
  const f = await capacityFixture(t), request = await input(f), before = await f.record();
  let cut = false;
  const interrupted = new KnowledgeStorage(f.config, f.db, stage => { if (stage === 'after-accept' && !cut) { cut = true; throw Error('interrupted'); } });
  await assert.rejects(interrupted.editBody(request, f.access), /interrupted/);
  const resumed = await new KnowledgeStorage(f.config, f.db).editBody(request, f.access);
  assert.equal(resumed.revision, before.revision + 1); assert.equal(resumed.state, 'published');
  assert.equal((await f.record()).body, request.replacement + before.body);
  const next = await input(f), raw = await readFile(f.file, 'utf8');
  const concurrent = new KnowledgeStorage(f.config, f.db, stage => { if (stage === 'before-accept') writeFileSync(f.file, raw + 'external'); });
  await assert.rejects(concurrent.editBody(next, f.access), /conflict/);
  assert.equal(await readFile(f.file, 'utf8'), raw + 'external');
});

test('service operation is agent-only and worker reads remain bounded for large single lines', async t => {
  const f = await capacityFixture(t, 400000), host = hostApi(f.base, { policy: { writesEnabled: true, operatorRead: true } });
  adopt(host.stateRoot, 'agent:main', f.config); const lifecycles = [];
  host.api.registerService = s => lifecycles.push(s);
  const service = createKnowledgeService(host.api); t.after(async () => { for (const s of lifecycles) await s.stop(); });
  const request = await input(f);
  await assert.rejects(service.edit_body(request, operatorContext(host.api)), /chat|agent/);
  assert.equal((await service.edit_body(request, toolContext(host.api))).state, 'published');
  const current = await f.record(); await writeFile(f.file, current.raw.slice(0, -current.body.length) + 'x'.repeat(400000));
  await assert.rejects(operations.memoryGet(f.storage, f.access, { id: request.id, from: 3, count: 100 }), /transport budget/);
});

test('range edits reject surrogate splits and lone surrogates, retaining complete emoji', () => {
  assert.equal(editBody('a😀b', { start: 1, end: 3, replacement: 'é' }), 'aéb');
  assert.throws(() => editBody('a😀b', { start: 2, end: 3, replacement: '' }), /Unicode/);
  assert.throws(() => editBody('abc', { start: 0, end: 0, replacement: '\ud800' }), /Unicode/);
});
