import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Check } from 'typebox/value';
import { createKnowledgeService } from '../dist/service.js';
import { deriveMemoryFlushRequestId } from '../dist/service.js';
import { buildKnowledgeMemoryPrompt } from '../dist/memory-prompt.js';
import { contract } from '../dist/contract.js';
import plugin from '../dist/index.js';
import { apiFor, hostApi } from './support.mjs';

async function fixture(t, overrides = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'knowledge-memory-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'vault'); await mkdir(root);
  const vaultId = randomUUID(), publicationId = randomUUID(), sessionId = randomUUID();
  await mkdir(path.join(root, 'private'));
  await mkdir(path.join(root, 'conversations', sessionId), { recursive: true });
  await writeFile(path.join(root, 'vault.json'), JSON.stringify({ format: 'knowledge-vault-v2', vaultId, generation: 0, publicationId }));
  let capability, active = true;
  const services = [];
  const api = apiFor(base, { root, statePath: path.join(base, 'state.sqlite'), vaultId, publicationId, operatorRead: true, writesEnabled: true, ...overrides },
    { extra: { registerMemoryCapability(c) { capability = c; }, registerService(s) { services.push(s); } } });
  const service = createKnowledgeService(api);
  const assertCurrent = () => { if (!active) throw Error('caller revoked'); };
  const audience = { kind: 'owner-private', agentId: 'main' };
  const context = { authority: { kind: 'session', sessionKey: 'agent:main:test', sessionId, sandboxed: false, audience }, assertCurrent };
  const tool = { source: 'tool', api, tool: { agentId: 'main', memoryAudience: audience, assertInvocationCurrent: assertCurrent, assertMemoryAudienceCurrent: assertCurrent } };
  const open = (ctx = context, agentId = 'main', purpose) => capability.providerRuntime.open({ cfg: {}, agentId, context: ctx, ...(purpose ? { purpose } : {}) });
  const save = (title, body = 'Evidence-backed durable note', ctx = tool) => service.save_page({ requestId: randomUUID(), expectedVaultId: vaultId, type: 'note', title, body }, ctx);
  const recall = async (target, set, ctx = tool) => {
    const current = (await service.record({ id: target.id }, ctx)).record;
    return service.recall({ requestId: randomUUID(), id: current.id, expectedRevision: current.revision, expectedHash: current.hash, set }, ctx);
  };
  return { api, service, services, open, save, recall, tool, context, sessionId, vaultId, root, capability,
    revoke() { active = false; }, setAudience(value) { context.authority.audience = value; tool.tool.memoryAudience = value; } };
}

test('shared search/get/health roundtrip uses native publication, provenance and revision refs', async t => {
  const f = await fixture(t);
  const saved = await f.save('Orchid decision', 'Choose SQLite\nBecause local persistence matters.');
  const { provider } = await f.open();
  assert.deepEqual(provider.capabilities, { sources: ['memory'], pagination: true, candidates: ['trigger', 'project'], projectFilter: false });
  const result = await provider.search({ query: 'Orchid' });
  assert.equal(result.hits.length, 1);
  const hit = result.hits[0];
  assert.deepEqual(hit.reference, { providerId: 'knowledge', id: saved.id, revision: `${saved.revision}:${saved.hash}@${f.vaultId}` });
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

test('conversation audiences never acquire private scope', async t => {
  const f = await fixture(t); await f.save('Private sentinel');
  const conversation = { kind: 'conversation', agentId: 'main', sessionKey: 'agent:main:group', sessionId: f.sessionId };
  f.setAudience(conversation);
  await f.save('Conversation sentinel');
  const { provider } = await f.open();
  const group = await provider.search({ query: 'sentinel' });
  assert.equal(group.hits.length, 1); assert.match(group.hits[0].excerpt, /Conversation/);
  assert.doesNotMatch(JSON.stringify(await provider.health()), /Private/);
  f.setAudience({ kind: 'owner-private', agentId: 'main' });
  await assert.rejects(provider.search({ query: 'sentinel' }), /authority/);
  const nonowner = await f.open({ ...f.context, authority: { ...f.context.authority, audience: conversation } });
  assert.equal((await nonowner.provider.search({ query: 'Private' })).hits.length, 0);
});

test('operator authorization and missing, foreign, host, and sandbox audience rejection', async t => {
  const f = await fixture(t); await f.save('Private note');
  const operator = { ...f.context, authority: { kind: 'operator', connId: 'real-connection', scopes: ['operator.read'] } };
  const operatorProvider = (await f.open(operator)).provider;
  assert.equal((await operatorProvider.search({ query: 'Private' })).hits.length, 1);
  await assert.rejects(operatorProvider.candidates({ kind: 'trigger' }), /owner-private/);
  for (const authority of [
    { kind: 'operator', scopes: ['operator.read'] }, { kind: 'operator', connId: 'x', scopes: [] },
    { kind: 'host', operation: 'bootstrap' }, { ...f.context.authority, sandboxed: true },
    { ...f.context.authority, audience: undefined },
    { ...f.context.authority, audience: { kind: 'owner-private', agentId: 'other' } },
  ]) await assert.rejects(f.open({ ...f.context, authority }), /authority/);
  await assert.rejects(f.open(f.context, 'other'), /authority/);
  await assert.rejects(f.open({ ...f.context, assertCurrent: undefined }), /authority/);
  const restricted = await fixture(t, { operatorRead: false }); await assert.rejects(restricted.open(operator), /authority/);
});

test('host status receives health only and every other host purpose is denied', async t => {
  const f = await fixture(t); await f.save('Private status sentinel');
  const host = { ...f.context, authority: { kind: 'host', operation: 'status' } };
  const { provider } = await f.open(host, 'main', 'status');
  const health = await provider.health();
  assert.deepEqual(Object.keys(health).sort(), ['message', 'status']);
  assert.equal(health.status, 'ready');
  assert.doesNotMatch(JSON.stringify(health), /records|issues|scope|sentinel|private|knowledge-memory-/i);
  await assert.rejects(provider.search({ query: 'sentinel' }), /authority/);
  await assert.rejects(provider.get({ reference: { providerId: 'knowledge', id: 'recordid' } }), /authority/);
  await assert.rejects(provider.candidates({ kind: 'trigger' }), /authority/);
  await provider.close();
  await assert.rejects(provider.health(), /closed/);
  for (const purpose of [undefined, 'default', 'cli']) await assert.rejects(f.open(host, 'main', purpose), /authority/);
});

test('host readiness redacts all states and storage errors while preserving lease fences', async () => {
  const { createKnowledgeMemoryRuntime } = await import('../dist/memory-provider.js');
  let facts = { ontology: true, issues: 0, records: 42 }, failure, active = true;
  const client = { async call(op) {
    assert.equal(op, 'memoryHealth');
    if (failure) throw failure;
    return facts;
  } };
  const runtime = { vaultId: randomUUID(), client, enqueue: (check, operation) => { check(); return operation(); } };
  const stores = { policy: { operatorRead: false }, incarnation: 0, assertLive() {}, async open(principal) {
    return { kind: 'ready', runtime, access: { ...principal(), assertCurrent: () => { principal(); } } };
  } };
  const context = { authority: { kind: 'host', operation: 'status' }, assertCurrent() { if (!active) throw Error('caller revoked'); } };
  const { provider } = await createKnowledgeMemoryRuntime(stores).open({ cfg: {}, agentId: 'main', purpose: 'status', context });
  for (const [ontology, issues, status] of [[true, 0, 'ready'], [true, 1, 'degraded'], [false, 0, 'unavailable']]) {
    facts = { ontology, issues, records: 42 };
    assert.deepEqual(await provider.health(), { status, message: 'Knowledge vault readiness check.' });
  }
  failure = Error('Failed private/secret-record.md in vault-id partition-id');
  assert.deepEqual(await provider.health(), { status: 'unavailable', message: 'Knowledge vault readiness unavailable.' });
  active = false;
  await assert.rejects(provider.health(), /caller revoked/);
  await provider.close();
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
  await assert.rejects(provider.get({ reference: { providerId: 'knowledge', id: saved.id, revision: `${saved.revision}:${saved.hash}@${f.vaultId}` } }), /changed/);
  // A reference minted by another store never resolves here.
  await assert.rejects(provider.get({ reference: { providerId: 'knowledge', id: saved.id, revision: `${saved.revision}:${saved.hash}@${randomUUID()}` } }), /different store/);
  await assert.rejects(provider.get({ reference: { providerId: 'other', id: saved.id } }), /reference/);
});

test('native mutation and shared reads use one operation queue; errors do not poison it', async t => {
  const f = await fixture(t), { provider } = await f.open();
  const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => [f.save(`Concurrent ${i}`), provider.search({ query: 'Concurrent' }), provider.health()]).flat());
  assert.deepEqual(results.filter(r => r.status === 'rejected').map(r => r.reason.message), []);
  await assert.rejects(provider.search({ query: '' }));
  assert.equal((await provider.search({ query: 'Concurrent' })).hits.length, 6);
});

test('unsupported corpus/project filters are explicit, mixed corpus is partial', async t => {
  const f = await fixture(t); await f.save('Orchid note'); const { provider } = await f.open();
  await assert.rejects(provider.search({ query: 'Orchid', sources: ['sessions'] }), /transcripts/);
  await assert.rejects(provider.search({ query: 'Orchid', activeProjectKeys: ['x'] }), /project/);
  const mixed = await provider.search({ query: 'Orchid', sources: ['sessions', 'memory'] });
  assert.equal(mixed.coverage, 'partial'); assert.match(mixed.warning, /not searched/);
  assert.equal(typeof provider.candidates, 'function'); assert.equal(provider.refresh, undefined);
  await assert.rejects(provider.candidates({ kind: 'project', activeProjectKeys: ['x'] }), /project-key/);
  for (const n of [0, -1, 51, NaN]) await assert.rejects(provider.search({ query: 'Orchid', maxResults: n }));
});

test('knowledge_recall sets and clears service approval with exact replay', async t => {
  const f = await fixture(t), saved = await f.save('Standing preference', 'BODY MUST NEVER BE AUTOMATICALLY INJECTED');
  const before = (await f.service.record({ id: saved.id }, f.tool)).record;
  const input = {
    requestId: randomUUID(), id: saved.id, expectedRevision: before.revision, expectedHash: before.hash,
    set: { summary: 'Prefer concise proof reports.', triggers: ['proof report'], importance: 8, projects: ['github.com/openclaw/knowledge'] },
  };
  const receipt = await f.service.recall(input, f.tool);
  assert.equal(receipt.state, 'published'); assert.equal(receipt.revision, before.revision + 1);
  assert.deepEqual(await f.service.recall(input, f.tool), receipt);
  let current = (await f.service.record({ id: saved.id, includeMetadata: true }, f.tool)).record;
  assert.equal(current.metadata.recall.approved_by, 'owner-private');
  assert.ok(Number.isFinite(Date.parse(current.metadata.recall.approved_at)));
  assert.equal(current.metadata.recall.summary, input.set.summary);
  const clear = { requestId: randomUUID(), id: saved.id, expectedRevision: current.revision, expectedHash: current.hash, clear: true };
  const cleared = await f.service.recall(clear, f.tool);
  assert.equal(cleared.revision, current.revision + 1);
  assert.deepEqual(await f.service.recall(clear, f.tool), cleared);
  current = (await f.service.record({ id: saved.id, includeMetadata: true }, f.tool)).record;
  assert.equal(current.metadata.recall, undefined);
});

test('knowledge_recall rejects non-owner authority, unavailable writes and invalid metadata', async t => {
  const f = await fixture(t), saved = await f.save('Approval target');
  const current = (await f.service.record({ id: saved.id }, f.tool)).record;
  const base = { requestId: randomUUID(), id: saved.id, expectedRevision: current.revision, expectedHash: current.hash };
  const conversation = { kind: 'conversation', agentId: 'main', sessionKey: 'agent:main:group', sessionId: f.sessionId };
  f.setAudience(conversation);
  await assert.rejects(f.service.recall({ ...base, set: { summary: 'Private context' } }, f.tool), /conversation audiences/);
  f.setAudience({ kind: 'owner-private', agentId: 'main' });
  const operator = { source: 'session-action', api: f.api, action: { client: { connId: 'browser', scopes: ['operator.write'] } } };
  await assert.rejects(f.service.recall({ ...base, set: { summary: 'Private context' } }, operator), /browser and operator/);
  const invalidSets = [
    { summary: '' }, { summary: '   ' }, { summary: 'x'.repeat(501) },
    { summary: 'ok', triggers: ['bad;phrase'] }, { summary: 'ok', triggers: ['bad\nphrase'] },
    { summary: 'ok', triggers: Array(21).fill('phrase') }, { summary: 'ok', importance: 11 },
    { summary: 'ok', projects: ['<unsafe>'] }, { summary: 'ok', projects: ['bad\nkey'] },
    { summary: 'ok', projects: Array(21).fill('project') }, { summary: 'ok', approved_by: 'owner-private' },
    { summary: 'ok', approved_at: new Date().toISOString() },
  ];
  for (const set of invalidSets) await assert.rejects(f.service.recall({ ...base, requestId: randomUUID(), set }, f.tool), /Invalid automatic recall input/);
  await assert.rejects(f.service.recall({ ...base, requestId: randomUUID(), set: { summary: 'ok' }, clear: true }, f.tool), /Invalid automatic recall input/);

  const readOnly = await fixture(t, { writesEnabled: false });
  await assert.rejects(readOnly.service.recall({ requestId: randomUUID(), id: randomUUID(), expectedRevision: 1, expectedHash: '0'.repeat(64), clear: true }, readOnly.tool), /writes are disabled/);
});

test('automatic candidates select by kind, inject summary only and order deterministically', async t => {
  const f = await fixture(t);
  const both = await f.save('Both candidate', 'SECRET BODY BOTH');
  const project = await f.save('Project candidate', 'SECRET BODY PROJECT');
  const trigger = await f.save('Trigger candidate', 'SECRET BODY TRIGGER');
  await f.recall(both, { summary: 'Approved both summary', triggers: ['both phrase', 'second phrase'], importance: 9, projects: ['project-a'] });
  await f.recall(project, { summary: 'Approved project summary', triggers: ['project phrase'], importance: 5, projects: ['project-b'] });
  await f.recall(trigger, { summary: 'Approved trigger summary', triggers: ['trigger phrase'], importance: 5 });
  const { provider } = await f.open();
  const triggers = await provider.candidates({ kind: 'trigger' });
  const tied = [project.id, trigger.id].sort();
  assert.deepEqual(triggers.hits.map(hit => hit.reference.id), [both.id, ...tied]);
  assert.deepEqual(triggers.hits[0].automaticRecall, { eligible: true, triggers: 'both phrase\nsecond phrase', importance: 9, projectKeys: ['project-a'] });
  assert.equal(triggers.hits[0].citations.length, 1);
  assert.equal(triggers.hits[0].citations[0].reference.id, both.id);
  assert.equal(triggers.hits[0].citations[0].label, `knowledge:${both.id}`);
  assert.doesNotMatch(JSON.stringify(triggers), /SECRET BODY/);
  const projects = await provider.candidates({ kind: 'project', limit: 1 });
  assert.deepEqual(projects.hits.map(hit => hit.reference.id), [both.id]);
  const search = await provider.search({ query: 'SECRET' });
  assert.ok(search.hits.every(hit => hit.automaticRecall.eligible === false));
  for (const limit of [0, -1, 201, NaN]) await assert.rejects(provider.candidates({ kind: 'trigger', limit }));

  f.setAudience({ kind: 'conversation', agentId: 'main', sessionKey: 'agent:main:group', sessionId: f.sessionId });
  const conversationProvider = (await f.open()).provider;
  assert.deepEqual(await conversationProvider.candidates({ kind: 'trigger' }), { hits: [], coverage: 'complete', warning: 'Automatic recall uses only owner-approved private records.' });
});

test('automatic candidates exclude withdrawn, superseded and invalid recall blocks', async t => {
  const f = await fixture(t);
  const withdrawn = await f.save('Withdrawn candidate'); await f.recall(withdrawn, { summary: 'withdrawn', triggers: ['withdrawn'] });
  let current = (await f.service.record({ id: withdrawn.id }, f.tool)).record;
  await f.service.withdraw({ requestId: randomUUID(), id: current.id, expectedRevision: current.revision, expectedHash: current.hash, reason: 'No longer current' }, f.tool);
  current = (await f.service.record({ id: withdrawn.id }, f.tool)).record;
  await assert.rejects(f.service.recall({ requestId: randomUUID(), id: current.id, expectedRevision: current.revision, expectedHash: current.hash, set: { summary: 'cannot restore' } }, f.tool), /unavailable, inactive, invalid, or changed/);

  const superseded = await f.save('Superseded candidate'); await f.recall(superseded, { summary: 'superseded', triggers: ['superseded'] });
  current = (await f.service.record({ id: superseded.id, view: 'raw' }, f.tool)).record;
  await writeFile(path.join(f.root, 'private', current.path), current.raw.replace('lifecycle: active', 'lifecycle: superseded'));

  const invalid = await f.save('Invalid recall candidate'); await f.recall(invalid, { summary: 'invalid', triggers: ['invalid'] });
  current = (await f.service.record({ id: invalid.id, view: 'raw' }, f.tool)).record;
  await writeFile(path.join(f.root, 'private', current.path), current.raw.replace('approved_by: owner-private', 'approved_by: forged'));

  const { provider } = await f.open();
  assert.deepEqual((await provider.candidates({ kind: 'trigger' })).hits, []);
  const inspected = await f.service.record({ id: invalid.id }, f.tool);
  assert.ok(inspected.record); assert.equal(inspected.record.valid, true);
  assert.ok(inspected.issues.some(issue => issue.code === 'invalid-recall'));
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

test('entry retains native tools, denies untrusted provider callers and prompt honors missing capabilities', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'knowledge-entry-')); t.after(() => rm(base, { recursive: true, force: true }));
  let capability; const names = [], services = [];
  plugin.register({ ...hostApi(base).api, registerMemoryCapability(c) { capability = c; }, registerService(s) { services.push(s); }, registerSessionAction() {}, registerTool(_f, options) { names.push(options.name); } });
  assert.equal(names.length, Object.values(contract.operations).filter(o => o.tool).length);
  assert.deepEqual(capability.recallToolNames, ['knowledge_grep', 'knowledge_lookup', 'knowledge_record']);
  assert.ok(capability.recallToolNames.every(name => names.includes(name)));
  // A host readiness lease validates storage but never releases content.
  const status = (await capability.providerRuntime.open({ cfg: {}, agentId: 'main', purpose: 'status', context: { authority: { kind: 'host', operation: 'status' }, assertCurrent() {} } })).provider;
  assert.deepEqual(await status.health(), { status: 'ready', message: 'Knowledge vault readiness check.' });
  await assert.rejects(status.search({ query: 'anything' }), /authority/);
  await assert.rejects(capability.providerRuntime.open({ cfg: {}, agentId: 'main', context: {} }), /authority/);
  assert.deepEqual(capability.promptBuilder({ availableTools: new Set() }), []);
  // Writes are on by default, so the provider owns the pre-compaction flush.
  assert.deepEqual(capability.providerFlushPlanResolver({}).persistenceToolNames, ['knowledge_save_page']);
  assert.deepEqual(buildKnowledgeMemoryPrompt({ availableTools: new Set() }), []);
});

test('entry registers without reading the host runtime, as CLI metadata loading requires', () => {
  // The host's CLI-metadata runtime throws on any property read.
  const runtime = new Proxy({}, { get(_t, key) { throw new Error(`runtime.${String(key)} is unavailable during registration`); } });
  let capability;
  plugin.register({ id: 'knowledge', pluginConfig: {}, runtime, registerMemoryCapability(c) { capability = c; }, registerService() {}, registerSessionAction() {}, registerTool() {} });
  assert.ok(capability.providerRuntime);
});

test('flush plan provides tool persistence only for writable real vaults', async t => {
  const f = await fixture(t);
  const plan = f.capability.providerFlushPlanResolver({ contextWindowTokens: 8_000 });
  assert.deepEqual(plan.persistenceToolNames, ['knowledge_save_page']);
  assert.deepEqual(plan.lookupToolNames, ['knowledge_grep', 'knowledge_lookup', 'knowledge_record', 'knowledge_ontology']);
  assert.equal(plan.relativePath, undefined);
  assert.equal(plan.reserveTokensFloor, undefined);
  assert.equal(plan.softThresholdTokens, undefined);
  assert.equal(plan.forceFlushTranscriptBytes, undefined);
  assert.equal(plan.model, undefined);
  const promptText = `${plan.prompt}\n${plan.systemPrompt}`;
  assert.match(plan.prompt, /knowledge_grep before saving/);
  assert.match(plan.prompt, /knowledge_lookup only for exact known record IDs, full titles, or aliases/);
  assert.match(plan.prompt, /already saved, do not save it again/);
  assert.match(plan.prompt, /knowledge_save_page/);
  assert.match(plan.prompt, /quoted source excerpt with attribution/);
  assert.match(plan.prompt, /enrich an appropriate existing page/);
  assert.match(plan.prompt, /linked to its resolved subject/);
  assert.match(plan.prompt, /knowledge_ontology for the active type definition/);
  assert.doesNotMatch(plan.prompt, /one focused page per topic/);
  assert.match(plan.prompt, /knowledge_record/);
  assert.match(plan.prompt, /NO_REPLY/);
  assert.deepEqual(
    [...new Set(promptText.match(/knowledge_[a-z_]+/g))].sort(),
    ['knowledge_grep', 'knowledge_lookup', 'knowledge_ontology', 'knowledge_record', 'knowledge_save_page'],
  );
  assert.equal(
    f.capability.providerFlushPlanResolver({ nowMs: 0 }).prompt,
    f.capability.providerFlushPlanResolver({ nowMs: Date.UTC(2036, 0, 1) }).prompt,
  );

  const readOnly = await fixture(t, { writesEnabled: false });
  assert.equal(readOnly.capability.providerFlushPlanResolver({}), null);
});

test('flush save derives stable scoped request IDs and preserves exact retry semantics', async t => {
  const f = await fixture(t);
  const flushContext = (flushId, base = f.tool) => ({
    ...base,
    tool: { ...base.tool, memoryFlush: { flushId } },
  });
  const input = {
    expectedVaultId: f.vaultId,
    type: 'note',
    title: 'Durable project decision',
    body: 'The team chose the indexed vault format.',
    source: { text: 'We chose the indexed vault format.', attribution: 'Conversation excerpt' },
  };
  assert.equal(Check(contract.operations.save_page.input, input), true);

  const first = await f.service.save_page(input, flushContext('flush-a'));
  assert.match(first.requestId, /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.deepEqual(await f.service.save_page(input, flushContext('flush-a')), first);
  await assert.rejects(
    f.service.save_page({ ...input, body: 'A different body.' }, flushContext('flush-a')),
    /different payload/,
  );

  const anotherFlush = await f.service.save_page(input, flushContext('flush-b'));
  const anotherTitle = await f.service.save_page({ ...input, title: 'Durable owner preference' }, flushContext('flush-a'));
  assert.notEqual(anotherFlush.requestId, first.requestId);
  assert.notEqual(anotherTitle.requestId, first.requestId);
  assert.equal(
    deriveMemoryFlushRequestId('flush-a', '  DURABLE   project decision  '),
    first.requestId,
  );
  await assert.rejects(
    f.service.save_page({ ...input, title: 'Outside flush' }, f.tool),
    /requires requestId outside a host pre-compaction memory flush/,
  );
  const supplied = randomUUID();
  assert.equal((await f.service.save_page({ ...input, requestId: supplied, title: 'Caller ID' }, flushContext('flush-a'))).requestId, supplied);
});

test('flush save follows delegated owner-private and conversation audiences', async t => {
  const f = await fixture(t);
  const flushContext = flushId => ({ ...f.tool, tool: { ...f.tool.tool, memoryFlush: { flushId } } });
  const privateReceipt = await f.service.save_page({ title: 'Private flush page', type: 'note', body: 'Private durable fact.' }, flushContext('private-flush'));
  assert.match(await readFile(path.join(f.root, 'private', privateReceipt.path), 'utf8'), /Private durable fact/);

  f.setAudience({ kind: 'conversation', agentId: 'main', sessionKey: 'agent:main:group', sessionId: f.sessionId });
  const conversationReceipt = await f.service.save_page({ title: 'Conversation flush page', type: 'note', body: 'Conversation durable fact.' }, flushContext('conversation-flush'));
  assert.match(await readFile(path.join(f.root, 'conversations', f.sessionId, conversationReceipt.path), 'utf8'), /Conversation durable fact/);
  assert.equal((await f.service.record({ id: privateReceipt.id }, f.tool)).record, null);
  assert.equal((await f.service.record({ id: conversationReceipt.id }, f.tool)).record.id, conversationReceipt.id);
});

test('grep and lookup expose empty and usable evidence for Active Memory', async t => {
  const f = await fixture(t);
  const factories = new Map();
  plugin.register({ ...f.api, registerSessionAction() {}, registerTool(factory, options) { factories.set(options.name, factory); } });
  // The feature adapter must expose the page count in both transcript details and JSON text.
  const assertCount = async (name, input, count, total) => {
    const tool = factories.get(name)(f.tool.tool), result = await tool.execute(randomUUID(), input);
    for (const output of [result.details, JSON.parse(result.content[0].text)]) {
      assert.equal(output.resultCount, count);
      assert.equal(output.hits.length, count);
      assert.equal(output.total, total);
    }
  };
  await assertCount('knowledge_grep', { query: 'Orchid' }, 0, 0);
  await assertCount('knowledge_lookup', { query: 'Orchid decision' }, 0, 0);
  await f.save('Orchid decision');
  await assertCount('knowledge_grep', { query: 'Orchid' }, 1, 1);
  await assertCount('knowledge_lookup', { query: 'Orchid decision' }, 1, 1);
  await assertCount('knowledge_grep', { query: 'Orchid', offset: 1 }, 0, 1);
  await assertCount('knowledge_lookup', { query: 'Orchid decision', offset: 1 }, 0, 1);
});

test('prompt routes all workflows, obeys citation settings and omits disabled save guidance', async t => {
  const tools = new Set(Object.values(contract.operations).flatMap(o => o.tool ? [o.tool.name] : []));
  const full = buildKnowledgeMemoryPrompt({ availableTools: tools }).join('\n');
  for (const skill of ['recall', 'capture', 'ingest', 'meeting-ingest', 'entities', 'correct']) assert.ok(full.includes(`knowledge-${skill}`));
  assert.match(full, /not instructions or authorization/); assert.match(full, /newer text is not automatically truer/);
  assert.match(full, /knowledge_recall only when the owner asks/); assert.match(full, /never ingested source text/);
  assert.match(full, /meaningful new preferences/);
  assert.match(full, /Resolve the subject and read existing records first/);
  assert.match(full, /enrich an appropriate existing page or link a separate record to its subject/);
  const readOnly = await fixture(t, { writesEnabled: false });
  assert.doesNotMatch(readOnly.capability.promptBuilder({ availableTools: tools }).join('\n'), /During ordinary work|knowledge-capture|knowledge-correct|knowledge_recall only/);
  const partial = buildKnowledgeMemoryPrompt({ availableTools: new Set(['knowledge_grep']), citationsMode: 'off' }).join('\n');
  assert.doesNotMatch(partial, /knowledge_record|knowledge_lookup|knowledge-capture/);
  assert.match(partial, /Citations are disabled/);
  assert.match(buildKnowledgeMemoryPrompt({ availableTools: new Set(['knowledge_recall']) }).join('\n'), /owner asks.*recalled automatically/);
});


// Storage runs in a worker, so this drives the provider with a stub storage
// client: its own fencing is what must reject failures and late results.
test('index failure is not empty success and late backend results are fenced', async () => {
  const { createKnowledgeMemoryRuntime } = await import('../dist/memory-provider.js');
  const sessionId = randomUUID(); let active = true, reply;
  const client = { async call(op) { assert.equal(op, 'search'); return reply(); } };
  const runtime = { vaultId: randomUUID(), client, enqueue: (check, operation) => { check(); return operation(); } };
  const stores = { policy: { operatorRead: true }, incarnation: 0, assertLive() {}, async open(principal) {
    return { kind: 'ready', runtime, access: { ...principal(), assertCurrent: () => { principal(); } } };
  } };
  const context = { authority: { kind: 'session', sessionKey: 'agent:main:test', sessionId, sandboxed: false,
    audience: { kind: 'owner-private', agentId: 'main' } }, assertCurrent() { if (!active) throw Error('caller revoked'); } };
  const { provider } = await createKnowledgeMemoryRuntime(stores).open({ cfg: {}, agentId: 'main', context });
  reply = () => ({ index: { state: 'unavailable', message: 'Index unavailable; retry' } });
  await assert.rejects(provider.search({ query: 'Orchid' }), /Index unavailable/);
  reply = () => { active = false; return { index: { state: 'ready', snapshot: 's', message: '' }, hits: [], total: 0, nextOffset: null, coverage: { complete: true, message: '' } }; };
  await assert.rejects(provider.search({ query: 'Orchid' }), /revoked/);
});

test('large provider reads follow advertised line continuations beyond 100000 and disclose opening excerpts', async t => {
  const f = await fixture(t), saved = await f.save('Many lines');
  const filename = path.join(f.root, 'private', saved.path), raw = await readFile(filename, 'utf8');
  await writeFile(filename, raw.slice(0, -'Evidence-backed durable note'.length) + 'short\n'.repeat(100300) + 'needle');
  const { provider } = await f.open();
  const result = await provider.search({ query: 'needle' });
  assert.match(result.hits[0].excerpt, /Opening excerpt \(not the match location\)/);
  const first = await provider.get({ reference: result.hits[0].reference, from: 99950, lines: 200 });
  assert.ok(first.nextFrom > 100000);
  const next = await provider.get({ reference: first.reference, from: first.nextFrom, lines: 200 });
  assert.equal(next.status, 'ok'); assert.match(next.text, /needle/); assert.equal(next.truncated, false);
});

test('recall keys and whole candidate responses stay bounded with honest partial coverage', async t => {
  const { stringify } = await import('yaml');
  const { withinBudget } = await import('../dist/response-budget.js');
  const f = await fixture(t), saved = await f.save('Candidate seed');
  await assert.rejects(f.recall(saved, { summary: 'approved', projects: ['x'.repeat(501)] }), /Invalid automatic recall input/);
  await f.recall(saved, { summary: 'approved', projects: ['x'.repeat(500)] });
  const original = (await f.service.record({ id: saved.id, metadataView: 'full' }, f.tool)).record;
  const metadata = original.metadata;
  // Many individually bounded records still exceed one response; use authored
  // synthetic fixtures to exercise the production scan/worker/provider chain.
  for (let n=0;n<35;n++) {
    const id = randomUUID();
    const m = { ...metadata, id, title: 'Candidate '+n, recall: { ...metadata.recall,
      projects: Array.from({length:20}, (_,i)=>String(i)+'é'.repeat(498)), summary:'Approved '+n } };
    await writeFile(path.join(f.root, 'private', path.dirname(saved.path), id+'.md'), '---\n'+stringify(m)+'---\nbody');
  }
  const { provider } = await f.open();
  const result = await provider.candidates({ kind:'project', limit:200 });
  assert.ok(result.hits.length > 0 && result.hits.length < 36);
  assert.equal(result.coverage,'partial'); assert.ok(withinBudget(result)); assert.match(result.warning,/budget/);
  const limited = await provider.candidates({ kind:'project', limit:1 });
  assert.equal(limited.hits.length,1); assert.equal(limited.coverage,'partial');
  // A huge manually-authored key must fail closed, never reach automatic recall.
  const id = randomUUID(), m = { ...metadata, id, recall:{...metadata.recall,projects:['x'.repeat(1000000)]} };
  await writeFile(path.join(f.root,'private',path.dirname(saved.path),id+'.md'), '---\n'+stringify(m)+'---\nbody');
  const invalid = await provider.candidates({kind:'project',limit:200});
  assert.equal(invalid.coverage,'partial'); assert.ok(withinBudget(invalid));
  assert.ok(!invalid.hits.some(h=>h.reference.id===id));
});
