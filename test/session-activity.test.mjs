import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Check } from 'typebox/value';
import { createKnowledgeService } from '../dist/service.js';
import { KnowledgeStorage } from '../dist/storage.js';
import { contract } from '../dist/contract.js';
import { appendActivity, sessionActivity, returnedRecords } from '../dist/session-activity.js';
import { hostApi, toolContext, operatorContext, createVault, plainAccess } from './support.mjs';

const origin = (sessionId = 'incarnation-a', toolCallId = randomUUID()) => ({ sessionKey: 'agent:main:activity', sessionId, toolCallId, operation: 'save', at: new Date().toISOString() });
const context = (api, o = origin()) => ({ ...toolContext(api), toolCallId: o.toolCallId, tool: { ...toolContext(api).tool, sessionKey: o.sessionKey, sessionId: o.sessionId } });

test('session reads and writes survive service reload; retries, inspector reads, resets and agents stay separate', async t => {
  const dir = await realpath(await mkdtemp('/tmp/knowledge-activity-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const { api } = hostApi(dir, { agents: ['main', 'other'], policy: { operatorRead: true, writesEnabled: true } });
  let service = createKnowledgeService(api);
  const o = origin(), ctx = context(api, o), op = operatorContext(api);
  const input = { requestId: randomUUID(), title: 'Session panel proof', type: 'note', body: 'A useful page.' };
  const receipt = await service.save_page(input, ctx);
  await service.save_page(input, context(api)); // new tool call retry must not reattribute a write
  await service.record({ id: receipt.id }, context(api));
  await service.grep({ query: 'panel' }, context(api));
  await service.record({ id: receipt.id }, op); // inspection is not agent activity
  const query = { sessionKey: o.sessionKey, sessionId: o.sessionId };
  let result = await service.session_activity(query, op);
  assert.ok(Check(contract.operations.session_activity.output, result));
  assert.deepEqual(result.items.map(x => x.action), ['read', 'read', 'write']);
  assert.deepEqual(result.items.map(x => x.operation), ['search', 'record', 'save']);
  assert.equal(result.items.at(-1).toolCallId, o.toolCallId);
  service = createKnowledgeService(api);
  assert.equal((await service.session_activity(query, op)).items.length, 3);
  assert.equal((await service.session_activity({ ...query, sessionId: 'reset' }, op)).items.length, 0);
  assert.equal((await service.session_activity({ ...query, sessionKey: 'other-session' }, op)).items.length, 0);
  assert.equal((await service.agent_query({ agent: 'other', operation: 'session_activity', input: query }, op)).items.length, 0);
  await assert.rejects(service.session_activity(query, ctx), /operator/);
  await assert.rejects(service.session_activity(query, operatorContext(api, [])), /authority/);
  const page = await service.session_activity({ ...query, limit: 1 }, op);
  const older = await service.session_activity({ ...query, limit: 1, upper: page.upper, before: page.nextBefore }, op);
  assert.ok(page.items[0].sequence > older.items[0].sequence);
  assert.equal((await service.session_activity({ ...query, filter: 'write' }, op)).items.length, 1);
  const record = await service.record({ id: receipt.id }, op);
  await service.withdraw({ requestId: randomUUID(), id: receipt.id, expectedRevision: record.record.revision, expectedHash: record.record.hash, reason: 'Testing current eligibility' }, ctx);
  assert.equal((await service.session_activity(query, op)).items.length, 0, 'Withdrawn content is not exposed in session activity');
});

test('accepted write captures original session before recovery, and commits exactly once', async t => {
  const dir = await realpath(await mkdtemp('/tmp/knowledge-activity-recovery-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const { config } = await createVault(dir); const o = origin();
  const access = { ...plainAccess(), activity: o };
  let fail = true;
  const storage = new KnowledgeStorage(config, undefined, stage => { if (stage === 'after-accept' && fail) { fail = false; throw Error('interrupted'); } });
  const input = { requestId: randomUUID(), title: 'Recovered write', type: 'note', body: 'Survives interruption.' };
  await assert.rejects(storage.save(input, access, 'agent'), /interrupted/);
  const recovered = new KnowledgeStorage(config);
  await recovered.resume({ ...plainAccess(), activity: origin('different-session') }, input.requestId);
  await recovered.resume(plainAccess(), input.requestId);
  const rows = await recovered.sessionActivity({ sessionKey: o.sessionKey, sessionId: o.sessionId }, plainAccess());
  assert.equal(rows.items.length, 1); assert.equal(rows.items[0].toolCallId, o.toolCallId);
  assert.equal((await recovered.sessionActivity({ sessionKey: o.sessionKey, sessionId: 'different-session' }, plainAccess())).items.length, 0);
});

test('activity filters current eligibility before pagination and keeps partitions isolated', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const active = [{ id: 'a', title: 'Visible', kind: 'page', type: 'note', revision: 1 }];
    const o = origin();
    for (let i = 0; i < 205; i++) appendActivity(db, 'private', 'main', { ...o, toolCallId: String(i) }, 'read', [{ id: i === 0 || i === 204 ? 'a' : 'hidden', revision: 1 }]);
    appendActivity(db, 'conversations/other', 'main', o, 'write', active);
    appendActivity(db, 'private', 'other', o, 'write', active);
    const query = { sessionKey: o.sessionKey, sessionId: o.sessionId, limit: 1 };
    const first = sessionActivity(db, 'private', 'main', active, query);
    assert.equal(first.items.length, 1); assert.ok(first.nextBefore);
    const second = sessionActivity(db, 'private', 'main', active, { ...query, before: first.nextBefore, upper: first.upper });
    assert.equal(second.items.length, 1); assert.equal(second.nextBefore, null);
    assert.equal(sessionActivity(db, 'private', 'main', [], query).items.length, 0);
  } finally { db.close(); }
});

test('read recording failure does not fail a successful read; revoked authority still fails delivery', async t => {
  const dir = await realpath(await mkdtemp('/tmp/knowledge-activity-failure-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const { config } = await createVault(dir);
  const storage = new KnowledgeStorage(config, { withDatabase() { throw Error('disk full'); } });
  const value = { record: { id: 'a', revision: 1 } };
  assert.deepEqual(await storage.trackRead({ ...plainAccess(), activity: origin() }, 'record', () => value), value);
  await assert.rejects(storage.trackRead({ ...plainAccess(), activity: origin(), assertCurrent() { throw Error('revoked'); } }, 'record', () => value), /revoked/);
  assert.deepEqual(returnedRecords({ body: '{"id":"bogus","revision":1}', record: null }), []);
});
