import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Check } from 'typebox/value';
import { createKnowledgeService } from '../dist/service.js';
import { contract } from '../dist/contract.js';
import { apiFor } from './support.mjs';

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'knowledge-remember-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'vault'); await mkdir(root); await mkdir(path.join(root, 'private'));
  const manifest = { format: 'knowledge-vault-v2', vaultId: randomUUID(), generation: 0, publicationId: randomUUID() };
  await writeFile(path.join(root, 'vault.json'), JSON.stringify(manifest));
  const config = { root, statePath: path.join(base, 'state.sqlite'), vaultId: manifest.vaultId, publicationId: manifest.publicationId, operatorRead: true, writesEnabled: true };
  const api = apiFor(base, config), service = createKnowledgeService(api);
  const owner = { source: 'tool', api, tool: { agentId: 'main', memoryAudience: { kind: 'owner-private', agentId: 'main' }, assertInvocationCurrent() {}, assertMemoryAudienceCurrent() {} } };
  const page = (title, extra = {}) => service.save_page({ requestId: randomUUID(), title, type: 'project', body: 'Project page.\n', ...extra }, owner);
  const remember = (items, extra = {}) => service.remember({ requestId: randomUUID(), attribution: 'user in test session, 2026-10-19', excerpt: 'User: we picked option B because it ships sooner.\nUser: I prefer short replies.', items, ...extra }, owner);
  return { service, owner, page, remember };
}

test('remember links a claim to a uniquely matching page and cites the retained excerpt', async t => {
  const f = await fixture(t);
  const project = await f.page('Garden Pilot', { aliases: ['pilot'] });
  const out = await f.remember([{ text: 'Picked option B because it ships sooner.', kind: 'decision', subject: 'pilot' }]);
  assert.ok(Check(contract.operations.remember.output, out));
  assert.equal(out.receipt.state, 'published');
  assert.deepEqual(out.items.map(i => [i.status, i.subject, i.subjectId]), [['inserted', 'attached', project.id]]);
  const read = await f.service.record({ id: out.items[0].id, includeMetadata: true, includeEvidence: true }, f.owner);
  assert.deepEqual(read.record.metadata.entities, [project.id]);
  assert.equal(read.record.metadata.claim_kind, 'decision');
  assert.equal(read.record.metadata.assertion_origin, 'source');
  assert.equal(read.evidence[0].verified, true);
  const claims = await f.service.connections({ id: project.id, direction: 'claims' }, f.owner);
  assert.equal(claims.connections[0].record.id, out.items[0].id);
});

test('exact repeats return the saved claim instead of writing again', async t => {
  const f = await fixture(t);
  await f.page('Garden Pilot');
  const first = await f.remember([{ text: 'Prefers short replies.', kind: 'preference', subject: 'Garden Pilot' }]);
  const again = await f.remember([{ text: '  prefers SHORT   replies. ', kind: 'preference', subject: 'garden pilot' }, { text: 'Ships Friday.', kind: 'commitment' }, { text: 'ships friday.', kind: 'commitment' }]);
  assert.deepEqual(again.items.map(i => i.status), ['duplicate', 'inserted', 'duplicate']);
  assert.equal(again.items[0].id, first.items[0].id);
  assert.equal(again.items[2].id, again.items[1].id);
  assert.equal((await f.service.records({ kind: 'claim' }, f.owner)).total, 2);
  const none = await f.remember([{ text: 'Prefers short replies.', kind: 'preference', subject: 'Garden Pilot' }]);
  assert.equal(none.receipt, null);
  assert.equal(none.items[0].status, 'duplicate');
});

test('unmatched and ambiguous subjects save unlinked, report candidates and create no page', async t => {
  const f = await fixture(t);
  const a = await f.page('Atlas'), b = await f.page('Atlas', { type: 'person' });
  const pages = (await f.service.records({ kind: 'page' }, f.owner)).total;
  const out = await f.remember([{ text: 'Atlas launched.', kind: 'event', subject: 'Atlas', occurred_at: '2026-10-18' }, { text: 'Nimbus is paused.', kind: 'fact', subject: 'Nimbus' }]);
  assert.equal(out.items[0].subject, 'ambiguous');
  assert.deepEqual(out.items[0].candidates.map(c => c.id).sort(), [a.id, b.id].sort());
  assert.equal(out.items[1].subject, 'missing');
  assert.equal((await f.service.records({ kind: 'page' }, f.owner)).total, pages);
  const unlinked = (await f.service.record({ id: out.items[1].id, includeMetadata: true }, f.owner)).record.metadata;
  assert.equal(unlinked.entities, undefined);
  assert.match(out.message, /2 unlinked/);
  assert.equal((await f.service.record({ id: out.items[0].id, includeMetadata: true }, f.owner)).record.metadata.occurred_at, '2026-10-18');
});

test('a replayed request returns its original result; a changed payload is rejected', async t => {
  const f = await fixture(t);
  const requestId = randomUUID(), items = [{ text: 'Uses link-only placement.', kind: 'decision' }];
  const first = await f.remember(items, { requestId });
  const replay = await f.remember(items, { requestId });
  assert.deepEqual(replay.items, first.items);
  assert.equal(replay.receipt.requestId, requestId);
  await assert.rejects(f.remember([{ text: 'Something else.', kind: 'fact' }], { requestId }), /different payload/);
});

test('remember rejects agent inference, oversized excerpts and missing request IDs outside a flush', async t => {
  const f = await fixture(t);
  await assert.rejects(f.remember([{ text: 'Seems tired.', kind: 'belief', origin: 'agent_inference' }]));
  await assert.rejects(f.remember([{ text: 'Big.', kind: 'fact' }], { excerpt: 'x'.repeat(17 * 1024) }));
  await assert.rejects(f.remember([{ text: 'No id.', kind: 'fact' }], { requestId: undefined }), /requires requestId/);
  const flush = { ...f.owner, tool: { ...f.owner.tool, memoryFlush: { flushId: 'flush-1' } } };
  const input = { attribution: 'flush', excerpt: 'User: keep it.', items: [{ text: 'Keep it.', kind: 'preference' }] };
  const saved = await f.service.remember(input, flush), retried = await f.service.remember(input, flush);
  assert.equal(saved.items[0].status, 'inserted');
  assert.deepEqual(retried.items, saved.items);
});
