import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Check } from 'typebox/value';
import { createKnowledgeService } from '../dist/service.js';
import { contract } from '../dist/contract.js';
import { apiFor } from './support.mjs';

// One private vault with two person pages that turn out to be one person.
async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'knowledge-merge-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'vault'); await mkdir(path.join(root, 'private'), { recursive: true });
  const manifest = { format: 'knowledge-vault-v2', vaultId: randomUUID(), generation: 0, publicationId: randomUUID() };
  await writeFile(path.join(root, 'vault.json'), JSON.stringify(manifest));
  const config = { root, statePath: path.join(base, 'state.sqlite'), vaultId: manifest.vaultId, publicationId: manifest.publicationId, operatorRead: true, writesEnabled: true };
  const api = apiFor(base, config), service = createKnowledgeService(api);
  const owner = { source: 'tool', api, tool: { agentId: 'main', memoryAudience: { kind: 'owner-private', agentId: 'main' }, assertInvocationCurrent() {}, assertMemoryAudienceCurrent() {} } };
  const call = (op, input) => service[op](input, owner);
  const fingerprint = (await call('ontology', {})).fingerprint;
  const page = (title, extra = {}) => call('save_page', { requestId: randomUUID(), title, type: 'person', body: `${title} notes.\n`, ...extra });
  const source = await call('attach', { requestId: randomUUID(), filename: 'chat.txt', mediaType: 'text/plain', attribution: 'Discord #maintainers', offset: 0,
    data: Buffer.from('jacob: I will review the PR by Friday.\nshakker: I am Gideon.').toString('base64'), final: true });
  const evidence = { ...source.evidence, start_line: 1, end_line: 1, quote: 'I will review the PR by Friday.' };
  const claim = (extra = {}) => call('create_claim', { requestId: randomUUID(), expectedOntologyFingerprint: fingerprint, title: 'Review commitment', body: 'Jacob will review the PR by Friday.',
    claim_kind: 'commitment', assertion_origin: 'source', attribution: 'jacob in #maintainers', evidence: [evidence], occurred_at: '2026-10-05', ...extra });
  const record = id => call('record', { id, metadataView: 'full' });
  const fence = async id => { const r = (await record(id)).record; return { id, expectedRevision: r.revision, expectedHash: r.hash }; };
  return { root, call, page, claim, record, fence, evidence, source, fingerprint };
}

async function merged(t) {
  const f = await fixture(t);
  f.survivor = await f.page('Jacob Tomlinson', { aliases: ['discord:111'], fields: {}, tags: ['maintainer'] });
  f.absorbed = await f.page('Jacob (standup participant)', { aliases: ['jacob-standup', 'discord:111'], tags: ['standup'] });
  f.owned = await f.claim({ owner: f.absorbed.id, entities: [f.absorbed.id] });
  f.linker = await f.page('Standup notes', { body: `Attended by [[${f.absorbed.id}]] and [[Jacob (standup participant)]].\n` });
  f.receipt = await f.call('merge', { requestId: randomUUID(), reason: 'Owner confirmed both pages are Jacob Tomlinson.',
    survivor: await f.fence(f.survivor.id), absorbed: await f.fence(f.absorbed.id) });
  return f;
}

test('a merge publishes both pages once and reports what changed', async t => {
  const f = await merged(t), r = f.receipt;
  assert.ok(Check(contract.operations.merge.output, r));
  assert.equal(r.state, 'published'); assert.equal(r.operation, 'merge');
  assert.equal(r.id, f.survivor.id); assert.equal(r.targetId, f.absorbed.id);
  assert.deepEqual(r.merge.aliases, ['Jacob (standup participant)', 'jacob-standup']);
  assert.equal(r.merge.redirectedRecords, 1, 'the owned claim named the absorbed page');
  const survivor = (await f.record(f.survivor.id)).record.metadata;
  assert.deepEqual(survivor.aliases, ['discord:111', 'Jacob (standup participant)', 'jacob-standup']);
  assert.deepEqual(survivor.tags, ['maintainer', 'standup']);
  assert.equal(survivor.merged_from[0].id, f.absorbed.id);
  const absorbed = await f.record(f.absorbed.id);
  assert.equal(absorbed.record.lifecycle, 'merged');
  assert.equal(absorbed.record.metadata.merged_into, f.survivor.id);
  assert.equal(absorbed.mergedInto.id, f.survivor.id, 'exact reads of the old page say where it went');
  assert.equal(absorbed.record.body, 'Jacob (standup participant) notes.\n', 'the absorbed body stays readable');
  assert.deepEqual((await f.record(f.survivor.id)).mergedFrom.map(p => p.id), [f.absorbed.id]);
});

test('reads follow the redirect without rewriting claims', async t => {
  const f = await merged(t);
  const claim = await f.record(f.owned.id);
  assert.equal(claim.record.metadata.owner, f.absorbed.id, 'the authored claim is unchanged');
  assert.equal(claim.record.owner.id, f.survivor.id, 'but it is shown as the survivor\'s');
  assert.deepEqual(claim.redirects, [{ from: f.absorbed.id, to: f.survivor.id }]);
  const lookup = await f.call('lookup', { query: f.absorbed.id });
  assert.equal(lookup.outcome, 'found'); assert.equal(lookup.hits[0].record.id, f.survivor.id); assert.equal(lookup.redirectedFrom, f.absorbed.id);
  assert.equal((await f.call('lookup', { query: 'Jacob (standup participant)' })).hits[0].record.id, f.survivor.id);
  assert.equal((await f.call('lookup', { query: 'discord:111' })).outcome, 'found', 'the shared identity key no longer splits');
  const connections = await f.call('connections', { id: f.survivor.id });
  assert.ok(connections.connections.some(c => c.direction === 'claims' && c.record.id === f.owned.id));
  assert.ok(connections.connections.some(c => c.direction === 'backlinks' && c.record.id === f.linker.id));
  const stale = await f.call('connections', { id: f.absorbed.id });
  assert.equal(stale.redirectedFrom, f.absorbed.id); assert.equal(stale.total, connections.total);
  const timeline = await f.call('timeline', { entity: f.survivor.id });
  assert.deepEqual(timeline.items.map(i => i.record.id), [f.owned.id]);
  assert.deepEqual((await f.call('timeline', { entity: f.absorbed.id })).items.map(i => i.record.id), [f.owned.id]);
  assert.deepEqual((await f.call('records', { kind: 'page', query: 'standup participant' })).records.map(r => r.id), [f.survivor.id], 'the merged page leaves listings');
  assert.equal((await f.call('grep', { query: 'standup participant notes' })).hits.some(h => h.record.id === f.absorbed.id), false, 'and search');
  const links = (await f.record(f.linker.id)).links;
  assert.deepEqual(links.map(l => [l.status, l.id]), [['resolved', f.survivor.id], ['resolved', f.survivor.id]]);
  assert.equal((await f.call('diagnostics', {})).total, 0, 'links to a merged page are not broken');
});

test('stale references to a merged page are rejected with the survivor named', async t => {
  const f = await merged(t);
  await assert.rejects(f.claim({ owner: f.absorbed.id }), new RegExp(`merged into ${f.survivor.id}`));
  await assert.rejects(f.call('save_page', { requestId: randomUUID(), ...(await f.fence(f.absorbed.id)), title: 'x', body: 'y' }), /was merged into/);
  await assert.rejects(f.call('merge', { requestId: randomUUID(), reason: 'again', survivor: await f.fence(f.survivor.id), absorbed: await f.fence(f.absorbed.id) }), /already merged/);
});

test('merges refuse different types, self merges and stale fences', async t => {
  const f = await fixture(t);
  const a = await f.page('Colin'), b = await f.call('save_page', { requestId: randomUUID(), title: 'Colin project', type: 'project', body: 'x\n' });
  await assert.rejects(f.call('merge', { requestId: randomUUID(), reason: 'r', survivor: await f.fence(a.id), absorbed: await f.fence(b.id) }), /same type/);
  await assert.rejects(f.call('merge', { requestId: randomUUID(), reason: 'r', survivor: await f.fence(a.id), absorbed: await f.fence(a.id) }), /into itself/);
  const c = await f.page('Colin B');
  await assert.rejects(f.call('merge', { requestId: randomUUID(), reason: 'r', survivor: await f.fence(a.id), absorbed: { ...(await f.fence(c.id)), expectedRevision: 9 } }), /changed/);
});

test('a merge can rename the survivor and replace its body; renamed titles stay resolvable', async t => {
  const f = await fixture(t);
  const a = await f.page('Shakker'), b = await f.page('Gideon Adegbesan', { fields: {} });
  const r = await f.call('merge', { requestId: randomUUID(), reason: 'Self-introduction in #maintainer-whois', survivor: await f.fence(a.id), absorbed: await f.fence(b.id),
    title: 'Gideon Adegbesan', body: 'Gideon Adegbesan, known as Shakker on Discord.\n', evidence: [{ ...f.evidence, start_line: 2, end_line: 2, quote: 'I am Gideon.' }] });
  const page = (await f.record(a.id)).record;
  assert.equal(page.title, 'Gideon Adegbesan'); assert.deepEqual(page.metadata.aliases, ['Shakker']);
  assert.equal(page.body, 'Gideon Adegbesan, known as Shakker on Discord.\n');
  assert.ok(page.metadata.evidence.some(e => e.quote === 'I am Gideon.'));
  assert.equal((await f.call('lookup', { query: 'Shakker' })).hits[0].record.id, a.id);
  assert.equal(r.merge.aliases.length, 1);
});

test('chained merges resolve to the final page', async t => {
  const f = await fixture(t);
  const a = await f.page('Jacob A'), b = await f.page('Jacob B'), c = await f.page('Jacob C');
  const owned = await f.claim({ owner: a.id });
  await f.call('merge', { requestId: randomUUID(), reason: 'same', survivor: await f.fence(b.id), absorbed: await f.fence(a.id) });
  await f.call('merge', { requestId: randomUUID(), reason: 'same', survivor: await f.fence(c.id), absorbed: await f.fence(b.id) });
  assert.equal((await f.record(owned.id)).record.owner.id, c.id);
  assert.equal((await f.call('lookup', { query: a.id })).hits[0].record.id, c.id);
  assert.deepEqual((await f.record(c.id)).mergedFrom.map(p => p.id).sort(), [a.id, b.id].sort());
});

test('unmerge restores the page and removes exactly what the merge added', async t => {
  const f = await merged(t);
  const r = await f.call('unmerge', { requestId: randomUUID(), reason: 'Different people after all.', merged: await f.fence(f.absorbed.id), survivor: await f.fence(f.survivor.id) });
  assert.ok(Check(contract.operations.unmerge.output, r));
  assert.equal(r.operation, 'unmerge'); assert.equal(r.merge.redirectedRecords, 1);
  const survivor = (await f.record(f.survivor.id)).record.metadata;
  assert.deepEqual(survivor.aliases, ['discord:111'], 'the shared identity key the survivor already had is kept');
  assert.deepEqual(survivor.tags, ['maintainer']); assert.equal(survivor.merged_from, undefined);
  const restored = (await f.record(f.absorbed.id)).record;
  assert.equal(restored.lifecycle, 'active'); assert.equal(restored.metadata.merged_into, undefined);
  assert.equal((await f.record(f.owned.id)).record.owner.id, f.absorbed.id);
  const candidates = (await f.call('diagnostics', {})).mergeCandidates;
  assert.deepEqual(candidates.map(c => [c.strength, c.key]), [['identity-key', 'discord:111']], 'the shared identity key is a merge candidate again');
});

test('diagnostics report merge candidates; invalid merge metadata fails closed', async t => {
  const f = await fixture(t);
  const a = await f.page('Colin', { aliases: ['discord:222'] }), b = await f.page('colin'), c = await f.page('Colin W', { aliases: ['Discord:222'] });
  const d = await f.call('diagnostics', {});
  assert.ok(Check(contract.operations.diagnostics.output, d));
  assert.deepEqual(d.mergeCandidates.map(g => [g.strength, g.pages.map(p => p.id).sort()]), [['identity-key', [a.id, c.id].sort()], ['title', [a.id, b.id].sort()]]);
  // Hand-edited merge metadata that points nowhere: the page is invalid and its dependents stay hidden.
  const owned = await f.claim({ owner: b.id });
  const file = path.join(f.root, 'private', (await f.record(b.id)).record.path);
  await writeFile(file, (await readFile(file, 'utf8')).replace('lifecycle: active', 'lifecycle: merged\nmerged_into: missing-page-0000'));
  const issues = (await f.call('diagnostics', {})).issues;
  assert.ok(issues.some(i => i.code === 'invalid-merge'));
  assert.equal((await f.call('lookup', { query: owned.id })).outcome, 'missing');
});
