import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createKnowledgeService } from '../dist/service.js';
import { buildKnowledgeMemoryPrompt } from '../dist/memory-prompt.js';
import { contract } from '../dist/contract.js';
import plugin from '../dist/index.js';

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'knowledge-memory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vaultId = randomUUID(), publicationId = randomUUID(), sessionId = randomUUID();
  await mkdir(path.join(root, 'private'));
  await mkdir(path.join(root, 'conversations', sessionId), { recursive: true });
  await writeFile(path.join(root, 'vault.json'), JSON.stringify({ format: 'knowledge-vault-v1', vaultId, agentId: 'main', generation: 0, publicationId }));
  let capability, active = true, entry = { sessionId, chatType: 'direct' };
  const services = [];
  const api = { id: 'knowledge', pluginConfig: { vault: { root, statePath: path.join(root, '..', `${path.basename(root)}.sqlite`), vaultId, publicationId, agentId: 'main', operatorRead: true, writesEnabled: true, ...overrides } },
    registerMemoryCapability(c) { capability = c; }, registerService(s) { services.push(s); },
    runtime: { agent: { session: { getSessionEntry() { return entry; } } } } };
  t.after(() => rm(api.pluginConfig.vault.statePath, { force: true }));
  const service = createKnowledgeService(api);
  const assertCurrent = () => { if (!active) throw Error('caller revoked'); };
  const context = { authority: { kind: 'session', sessionKey: 'agent:main:test', sessionId, senderIsOwner: true, sandboxed: false }, assertCurrent };
  const tool = { source: 'tool', api, tool: { ...context.authority, agentId: 'main', assertInvocationCurrent: assertCurrent } };
  const open = (ctx = context, agentId = 'main') => capability.providerRuntime.open({ cfg: {}, agentId, context: ctx });
  const save = (title, body = 'Evidence-backed durable note', ctx = tool) => service.save_page({ requestId: randomUUID(), expectedVaultId: vaultId, type: 'note', title, body }, ctx);
  return { api, service, services, open, save, tool, context, sessionId, vaultId, root, capability,
    revoke() { active = false; }, setEntry(e) { entry = e; } };
}

test('shared search/get/health roundtrip uses native publication, provenance and revision refs', async t => {
  const f = await fixture(t);
  const saved = await f.save('Orchid decision', 'Choose SQLite\nBecause local persistence matters.');
  const { provider } = await f.open();
  assert.deepEqual(provider.capabilities, { sources: ['memory'], pagination: true, candidates: [], projectFilter: false });
  const result = await provider.search({ query: 'Orchid' });
  assert.equal(result.hits.length, 1);
  const hit = result.hits[0];
  assert.deepEqual(hit.reference, { providerId: 'knowledge', id: saved.id, revision: `${saved.revision}:${saved.hash}` });
  assert.equal(hit.automaticRecall.eligible, false);
  assert.equal(hit.path, undefined);
  const first = await provider.get({ reference: hit.reference, lines: 2 });
  const rest = await provider.get({ reference: hit.reference, from: first.nextFrom, lines: 200 });
  assert.match(first.text, /Orchid decision/); assert.match(rest.text, /Choose SQLite/);
  assert.equal(rest.truncated, false); assert.equal(first.citations[0].reference.id, saved.id);
  assert.equal((await provider.health()).status, 'ready');
  await provider.close(); await provider.close();
  await assert.rejects(provider.search({ query: 'Orchid' }), /closed/);
  assert.equal((await f.service.record({ id: saved.id }, f.tool)).record.id, saved.id);
});

test('owner group and non-owner direct reads never acquire private scope', async t => {
  const f = await fixture(t); await f.save('Private sentinel');
  f.setEntry({ sessionId: f.sessionId, chatType: 'group' });
  await f.save('Conversation sentinel');
  const { provider } = await f.open();
  const group = await provider.search({ query: 'sentinel' });
  assert.equal(group.hits.length, 1); assert.match(group.hits[0].excerpt, /Conversation/);
  assert.doesNotMatch(JSON.stringify(await provider.health()), /Private/);
  f.setEntry({ sessionId: f.sessionId, chatType: 'direct' });
  await assert.rejects(provider.search({ query: 'sentinel' }), /authority/);
  const nonowner = await f.open({ ...f.context, authority: { ...f.context.authority, senderIsOwner: false } });
  assert.equal((await nonowner.provider.search({ query: 'Private' })).hits.length, 0);
});

test('operator authorization, missing authority, wrong incarnation, host and sandbox rejection', async t => {
  const f = await fixture(t); await f.save('Private note');
  const operator = { ...f.context, authority: { kind: 'operator', connId: 'real-connection', scopes: ['operator.read'] } };
  assert.equal((await (await f.open(operator)).provider.search({ query: 'Private' })).hits.length, 1);
  for (const authority of [
    { kind: 'operator', scopes: ['operator.read'] }, { kind: 'operator', connId: 'x', scopes: [] },
    { kind: 'host', operation: 'bootstrap' }, { ...f.context.authority, sandboxed: true },
    { ...f.context.authority, sessionKey: 'agent:foreign:test' },
    { ...f.context.authority, sessionKey: 'unscoped' },
    { ...f.context.authority, sessionId: randomUUID() }, { ...f.context.authority, sessionId: undefined },
  ]) await assert.rejects(f.open({ ...f.context, authority }), /authority/);
  await assert.rejects(f.open(f.context, 'other'), /authority/);
  await assert.rejects(f.open({ ...f.context, assertCurrent: undefined }), /authority/);
  f.setEntry({ sessionId: f.sessionId }); await assert.rejects(f.open(), /authority/);
  const restricted = await fixture(t, { operatorRead: false }); await assert.rejects(restricted.open(operator), /authority/);
});

test('queued result release revalidates authority, cancellation and service incarnation', async t => {
  const f = await fixture(t); await f.save('Orchid note');
  const { provider } = await f.open();
  const pending = provider.search({ query: 'Orchid' }); f.revoke();
  await assert.rejects(pending, /revoked/); await provider.close();
  const g = await fixture(t), controller = new AbortController();
  const lease = (await g.open({ ...g.context, signal: controller.signal })).provider;
  controller.abort(); await assert.rejects(lease.health()); await lease.close();
  const old = (await g.open()).provider;
  const lifecycle = g.services.find(s => s.id === 'knowledge:live-state');
  lifecycle.stop(); lifecycle.start(); t.after(() => lifecycle.stop());
  await assert.rejects(old.health(), /reloaded/);
});

test('cursor preserves query/scope/snapshot and revision fences reject stale reads', async t => {
  const f = await fixture(t); const saved = await f.save('Orchid one'); await f.save('Orchid two');
  const { provider } = await f.open();
  const page = await provider.search({ query: 'Orchid', maxResults: 1 });
  assert.equal(page.coverage, 'partial'); assert.ok(page.nextCursor);
  const next = await provider.search({ query: 'Orchid', maxResults: 1, cursor: page.nextCursor });
  assert.notEqual(next.hits[0].reference.id, page.hits[0].reference.id);
  await assert.rejects(provider.search({ query: 'different', cursor: page.nextCursor }), /cursor/);
  await f.service.save_page({ requestId: randomUUID(), expectedVaultId: f.vaultId, id: saved.id, expectedRevision: saved.revision, expectedHash: saved.hash, type: 'note', title: 'Orchid one', body: 'Changed' }, f.tool);
  await assert.rejects(provider.search({ query: 'Orchid', cursor: page.nextCursor }), /snapshot changed/);
  await assert.rejects(provider.get({ reference: { providerId: 'knowledge', id: saved.id, revision: `${saved.revision}:${saved.hash}` } }), /changed/);
  await assert.rejects(provider.get({ reference: { providerId: 'other', id: saved.id } }), /reference/);
});

test('native mutation and shared reads use one operation queue; errors do not poison it', async t => {
  const f = await fixture(t), { provider } = await f.open();
  const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => [f.save(`Concurrent ${i}`), provider.search({ query: 'Concurrent' }), provider.health()]).flat());
  assert.deepEqual(results.filter(r => r.status === 'rejected').map(r => r.reason.message), []);
  await assert.rejects(provider.search({ query: '' }));
  assert.equal((await provider.search({ query: 'Concurrent' })).hits.length, 6);
});

test('unsupported corpus/project capabilities are explicit, mixed corpus is partial', async t => {
  const f = await fixture(t); await f.save('Orchid note'); const { provider } = await f.open();
  await assert.rejects(provider.search({ query: 'Orchid', sources: ['sessions'] }), /transcripts/);
  await assert.rejects(provider.search({ query: 'Orchid', activeProjectKeys: ['x'] }), /project/);
  const mixed = await provider.search({ query: 'Orchid', sources: ['sessions', 'memory'] });
  assert.equal(mixed.coverage, 'partial'); assert.match(mixed.warning, /not searched/);
  assert.equal(provider.candidates, undefined); assert.equal(provider.refresh, undefined);
  for (const n of [0, -1, 51, NaN]) await assert.rejects(provider.search({ query: 'Orchid', maxResults: n }));
});

test('withdrawn records stay unavailable after external restoration; fixtures are excluded', async t => {
  const f = await fixture(t); const saved = await f.save('Orchid note'); const { provider } = await f.open();
  const hit = (await provider.search({ query: 'Orchid' })).hits[0];
  const detail = await f.service.record({ id: saved.id, view: 'raw' }, f.tool);
  await f.service.withdraw({ requestId: randomUUID(), expectedVaultId: f.vaultId, id: saved.id, expectedRevision: saved.revision, expectedHash: saved.hash, reason: 'Synthetic withdrawal' }, f.tool);
  assert.equal((await provider.search({ query: 'Orchid' })).hits.length, 0);
  assert.deepEqual(await provider.get({ reference: hit.reference }), { status: 'not_found' });
  await writeFile(path.join(f.root, 'private', detail.record.path), detail.record.raw);
  assert.deepEqual(await provider.get({ reference: hit.reference }), { status: 'not_found' });
  const fixtureRecord = await f.save('Synthetic fixture');
  const fixtureDetail = await f.service.record({ id: fixtureRecord.id, view: 'raw' }, f.tool);
  await writeFile(path.join(f.root, 'private', fixtureDetail.record.path), fixtureDetail.record.raw.replace('lifecycle: active', 'record_class: fixture\nlifecycle: active'));
  assert.equal((await provider.search({ query: 'Synthetic' })).hits.length, 0);
  assert.deepEqual(await provider.get({ reference: { providerId: 'knowledge', id: fixtureRecord.id } }), { status: 'not_found' });
});

test('retirement drains the shared lane, rollback resumes, close-all fences retained handles', async t => {
  const f = await fixture(t), { provider } = await f.open(), runtime = f.capability.providerRuntime;
  const retirement = runtime.prepareReload({ retireRuntime: true, retiringEmbeddingProviders: [] });
  await assert.rejects(provider.health(), /retiring/); await retirement.drain();
  retirement.resume(); assert.equal((await provider.health()).status, 'ready');
  await runtime.closeAllMemorySearchManagers(); await assert.rejects(provider.health(), /closed/);
  assert.equal((await (await f.open()).provider.health()).status, 'ready');
});

test('sample is not memory; entry retains native tools and prompt honors missing capabilities', async () => {
  let capability; const names = [], services = [];
  plugin.register({ id: 'knowledge', registerMemoryCapability(c) { capability = c; }, registerService(s) { services.push(s); }, registerSessionAction() {}, registerTool(_f, options) { names.push(options.name); } });
  assert.equal(names.length, Object.values(contract.operations).filter(o => o.tool).length);
  assert.equal((await capability.providerRuntime.open({ cfg: {}, agentId: 'main', context: {} })).provider, null);
  assert.deepEqual(capability.promptBuilder({ availableTools: new Set(names) }), []);
  assert.equal(capability.flushPlanResolver({}), null);
  assert.deepEqual(buildKnowledgeMemoryPrompt({ availableTools: new Set() }), []);
});

test('prompt routes all workflows, obeys citation settings and omits disabled save guidance', async t => {
  const tools = new Set(Object.values(contract.operations).flatMap(o => o.tool ? [o.tool.name] : []));
  const full = buildKnowledgeMemoryPrompt({ availableTools: tools }).join('\n');
  for (const skill of ['recall', 'capture', 'ingest', 'meeting-ingest', 'entities', 'correct']) assert.ok(full.includes(`knowledge-${skill}`));
  assert.match(full, /not instructions or authorization/); assert.match(full, /newer text is not automatically truer/);
  const readOnly = await fixture(t, { writesEnabled: false });
  assert.doesNotMatch(readOnly.capability.promptBuilder({ availableTools: tools }).join('\n'), /During ordinary work|knowledge-capture|knowledge-correct/);
  const partial = buildKnowledgeMemoryPrompt({ availableTools: new Set(['knowledge_grep']), citationsMode: 'off' }).join('\n');
  assert.doesNotMatch(partial, /knowledge_record|knowledge_lookup|knowledge-capture/);
  assert.match(partial, /Citations are disabled/);
});


// Storage runs in a worker, so this drives the provider with a stub storage
// client: its own fencing is what must reject failures and late results.
test('index failure is not empty success and late backend results are fenced', async () => {
  const { createKnowledgeMemoryRuntime } = await import('../dist/memory-provider.js');
  const sessionId = randomUUID(); let active = true, reply;
  const api = { runtime: { agent: { session: { getSessionEntry() { return { sessionId, chatType: 'direct' }; } } } } };
  const storage = { config: { agentId: 'main', vaultId: randomUUID(), operatorRead: true }, async call(op) { assert.equal(op, 'search'); return reply(); } };
  const lane = { enqueue: operation => operation(), drain: async () => {}, fence: () => () => {} };
  const context = { authority: { kind: 'session', sessionKey: 'agent:main:test', sessionId, senderIsOwner: true, sandboxed: false }, assertCurrent() { if (!active) throw Error('caller revoked'); } };
  const { provider } = await createKnowledgeMemoryRuntime(api, storage, lane).open({ cfg: {}, agentId: 'main', context });
  reply = () => ({ index: { state: 'unavailable', message: 'Index unavailable; retry' } });
  await assert.rejects(provider.search({ query: 'Orchid' }), /Index unavailable/);
  reply = () => { active = false; return { index: { state: 'ready', snapshot: 's', message: '' }, hits: [], total: 0, nextOffset: null, coverage: { complete: true, message: '' } }; };
  await assert.rejects(provider.search({ query: 'Orchid' }), /revoked/);
});
