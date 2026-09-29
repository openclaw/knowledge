import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, rename, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Check } from 'typebox/value';
import { createKnowledgeService } from '../dist/service.js';
import { contract } from '../dist/contract.js';
import { StoreRegistry } from '../dist/store-registry.js';
import { hostApi, toolContext, operatorContext } from './support.mjs';
import { Stores } from '../dist/stores.js';
import { storesRevision } from '../dist/stores-config.js';

// Every scenario starts from an empty Knowledge state root: stores exist only
// once an agent uses one, exactly as on a fresh install.
async function fixture(t, options = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'knowledge-stores-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const services = [];
  const host = hostApi(base, { agents: ['main', 'research', 'ops'], policy: { operatorRead: true, writesEnabled: true }, ...options, extra: { registerService: s => services.push(s) } });
  const service = createKnowledgeService(host.api);
  t.after(() => services.forEach(s => s.stop()));
  const admin = operatorContext(host.api, ['operator.admin']), reader = operatorContext(host.api, ['operator.read']);
  const as = agent => toolContext(host.api, agent);
  const save = (agent, title) => service.save_page({ requestId: randomUUID(), title, type: 'note', body: `${title} body.` }, as(agent));
  const titles = async (agent) => (await service.records({}, as(agent))).records.map(r => r.title).sort();
  const snapshot = () => service.stores_snapshot({}, admin);
  const change = async (agent, change, expectedRevision) => {
    const input = { requestId: randomUUID(), expectedRevision: expectedRevision ?? (await snapshot()).revision, agent, change };
    assert.ok(Check(contract.operations.stores_change.input, input));
    const result = await service.stores_change(input, admin);
    assert.ok(Check(contract.operations.stores_change.output, result), JSON.stringify(result));
    return { input, result };
  };
  const storesDir = () => readdir(path.join(host.stateRoot, 'stores')).catch(() => []);
  return { ...host, base, service, admin, reader, as, save, titles, snapshot, change, storesDir };
}
const entry = (snapshot, binding) => snapshot.stores.find(s => s.binding === binding);

test('two unassigned agents get separate stores on first use and cannot read each other', async t => {
  const f = await fixture(t);
  await f.save('main', 'Main private'); await f.save('research', 'Research private');
  assert.deepEqual(await f.titles('main'), ['Main private']);
  assert.deepEqual(await f.titles('research'), ['Research private']);
  assert.equal((await f.storesDir()).length, 2);
});

test('passive discovery never creates storage', async t => {
  const f = await fixture(t);
  const snap = await f.snapshot();
  assert.ok(Check(contract.operations.stores_snapshot.output, snap));
  assert.deepEqual(snap.agents.map(a => [a.id, a.binding]), [['main', 'agent:main'], ['research', 'agent:research'], ['ops', 'agent:ops']]);
  assert.ok(snap.stores.every(s => s.state === 'unprovisioned'));
  const status = await f.service.status({}, f.reader);
  assert.equal(status.store, 'unprovisioned');
  assert.equal((await f.service.agent_query({ agent: 'research', operation: 'records', input: {} }, f.reader)).total, 0);
  assert.equal((await f.service.agent_query({ agent: 'research', operation: 'status', input: {} }, f.reader)).store, 'unprovisioned');
  assert.deepEqual(await f.storesDir(), []);
});

test('concurrent first uses converge on one store identity', async t => {
  const f = await fixture(t);
  await Promise.all([f.save('main', 'One'), f.save('main', 'Two'), f.save('main', 'Three')]);
  assert.equal((await f.storesDir()).length, 1);
  assert.deepEqual(await f.titles('main'), ['One', 'Three', 'Two']);
});

test('interrupted initialization resumes the same identity', async t => {
  const f = await fixture(t);
  // Simulate a crash after the reservation committed but before any file work.
  const reserve = new StoreRegistry(f.stateRoot);
  reserve['tx'](() => {
    reserve['db'].prepare("INSERT INTO stores VALUES (?,?,?,?,'initializing',?)").run('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
      path.join(f.stateRoot, 'stores', '11111111-1111-4111-8111-111111111111', 'vault'), path.join(f.stateRoot, 'stores', '11111111-1111-4111-8111-111111111111', 'state.sqlite'), new Date().toISOString());
    reserve['db'].prepare("INSERT INTO bindings(binding,vault_id) VALUES ('agent:main','11111111-1111-4111-8111-111111111111')").run();
  });
  reserve.close();
  await f.save('main', 'After crash');
  assert.deepEqual(await f.storesDir(), ['11111111-1111-4111-8111-111111111111']);
  assert.equal((await f.service.status({}, f.as('main'))).vault, '11111111-1111-4111-8111-111111111111');
});

test('a provisioned store that disappears is unavailable, never recreated empty', async t => {
  const f = await fixture(t);
  await f.save('main', 'Kept');
  const [dir] = await f.storesDir();
  await rename(path.join(f.stateRoot, 'stores', dir), path.join(f.base, 'moved-away'));
  const fresh = createKnowledgeService(f.api);
  await assert.rejects(fresh.save_page({ requestId: randomUUID(), title: 'Must not land', type: 'note', body: 'x' }, f.as('main')), /identity|unavailable/);
  assert.equal(entry(await fresh.stores_snapshot({}, f.admin), 'agent:main').state, 'unavailable');
  assert.deepEqual(await f.storesDir(), []);
});

test('a missing registry beside existing stores requires recovery', async t => {
  const f = await fixture(t);
  await f.save('main', 'Kept');
  await rename(path.join(f.stateRoot, 'registry.sqlite'), path.join(f.base, 'registry.bak'));
  const fresh = createKnowledgeService(f.api);
  await assert.rejects(fresh.save_page({ requestId: randomUUID(), title: 'x', type: 'note', body: 'x' }, f.as('main')), /registry/);
  const snap = await fresh.stores_snapshot({}, f.admin);
  assert.equal(snap.canChange, false); assert.match(snap.issues[0], /registry/);
});

test('share existing: same identity and records; members read and update through one store', async t => {
  const f = await fixture(t);
  await f.save('main', 'Before sharing');
  const before = await f.service.status({}, f.as('main'));
  const { result } = await f.change('main', { kind: 'share_existing', label: 'Personal', agents: ['research'] });
  assert.equal(result.outcome, 'applied', result.message);
  const shared = entry(result.snapshot, 'named:personal');
  assert.deepEqual(shared.members, ['main', 'research']); assert.equal(shared.label, 'Personal');
  assert.equal(entry(result.snapshot, 'agent:main'), undefined, 'the original isolated binding moved to the named store');
  assert.equal((await f.service.status({}, f.as('research'))).vault, before.vault);
  assert.deepEqual(await f.titles('research'), ['Before sharing']);
  await f.save('research', 'Research addition');
  assert.deepEqual(await f.titles('main'), ['Before sharing', 'Research addition']);
  // Writer attribution follows the publishing agent, not the viewer.
  const records = (await f.service.records({}, f.as('main'))).records;
  assert.equal(records.find(r => r.title === 'Research addition').writtenByAgentId, 'research');
  assert.equal(records.find(r => r.title === 'Before sharing').writtenByAgentId, 'main');
  // Configuration holds membership; nothing wrote an agent path.
  assert.deepEqual(f.host.config.plugins.entries.knowledge.config.stores, { personal: { label: 'Personal', agents: ['main', 'research'] } });
  assert.equal((await f.storesDir()).length, 1);
});

test('use own after sharing: joiner resumes its old store; originating sharer gets a fresh lazy default', async t => {
  const f = await fixture(t);
  await f.save('main', 'Shared seed'); await f.save('research', 'Research own');
  assert.equal((await f.change('main', { kind: 'share_existing', label: 'Team', agents: ['research'] })).result.outcome, 'applied');
  assert.deepEqual(await f.titles('research'), ['Shared seed']);
  const back = await f.change('research', { kind: 'use_own' });
  assert.equal(back.result.outcome, 'applied', back.result.message);
  assert.deepEqual(await f.titles('research'), ['Research own']);
  const own = await f.change('main', { kind: 'use_own' });
  assert.equal(own.result.outcome, 'applied');
  assert.equal(entry(own.result.snapshot, 'agent:main').state, 'unprovisioned');
  // Zero members: the named store is retained with its data and stays assignable.
  const team = entry(own.result.snapshot, 'named:team');
  assert.deepEqual(team.members, []); assert.equal(team.state, 'ready');
  assert.deepEqual(await f.titles('main'), []);
  assert.equal((await f.change('ops', { kind: 'use_named', store: 'team' })).result.outcome, 'applied');
  assert.deepEqual(await f.titles('ops'), ['Shared seed']);
});

test('switching named stores leaves one assignment and the former store untouched', async t => {
  const f = await fixture(t);
  await f.save('main', 'Alpha'); await f.save('ops', 'Beta');
  await f.change('main', { kind: 'share_existing', label: 'A', agents: ['research'] });
  const b = await f.change('ops', { kind: 'share_existing', label: 'B', agents: ['main'] });
  assert.equal(b.result.outcome, 'applied', b.result.message);
  const stores = f.host.config.plugins.entries.knowledge.config.stores;
  assert.deepEqual(stores.a.agents, ['research']); assert.deepEqual(stores.b.agents, ['ops', 'main']);
  assert.deepEqual(await f.titles('main'), ['Beta']);
  assert.deepEqual(await f.titles('research'), ['Alpha']);
});

test('validation, stale revisions and non-admin callers never partially apply', async t => {
  const f = await fixture(t);
  await f.save('main', 'Seed');
  const stale = (await f.snapshot()).revision;
  assert.equal((await f.change('research', { kind: 'share_existing', label: 'Nope', agents: ['main'] })).result.outcome, 'invalid', 'unprovisioned source');
  assert.equal((await f.change('main', { kind: 'use_named', store: 'missing' })).result.outcome, 'invalid');
  assert.equal((await f.change('main', { kind: 'use_own' })).result.outcome, 'invalid');
  assert.equal((await f.change('main', { kind: 'share_existing', label: 'Team', agents: ['ghost'] })).result.outcome, 'invalid');
  assert.equal((await f.change('main', { kind: 'share_existing', label: 'Team', agents: ['research'] })).result.outcome, 'applied');
  assert.equal((await f.change('ops', { kind: 'use_named', store: 'team' }, stale)).result.outcome, 'conflict');
  const denied = await f.service.stores_change({ requestId: randomUUID(), expectedRevision: (await f.snapshot()).revision, agent: 'ops', change: { kind: 'use_named', store: 'team' } }, operatorContext(f.api, ['operator.write']));
  assert.equal(denied.outcome, 'forbidden');
  assert.equal((await f.service.stores_snapshot({}, f.reader)).canChange, false);
  await assert.rejects(f.service.stores_snapshot({}, f.as('main')), /operators/);
  assert.deepEqual(Object.keys(f.host.config.plugins.entries.knowledge.config.stores), ['team']);
});

test('a concurrent config edit inside the write is a conflict, not an overwrite', async t => {
  const f = await fixture(t);
  await f.save('main', 'Seed');
  const original = f.api.runtime.config.mutateConfigFile;
  f.api.runtime.config.mutateConfigFile = async params => {
    f.host.config = structuredClone(f.host.config);
    f.host.config.plugins.entries.knowledge.config.stores = { other: { agents: ['ops'] } };
    return original(params);
  };
  const { result } = await f.change('main', { kind: 'share_existing', label: 'Team', agents: ['research'] });
  assert.equal(result.outcome, 'conflict');
  assert.deepEqual(f.host.config.plugins.entries.knowledge.config.stores, { other: { agents: ['ops'] } });
});

test('repeated request IDs replay the outcome; reuse for another change is rejected', async t => {
  const f = await fixture(t);
  await f.save('main', 'Seed');
  const { input, result } = await f.change('main', { kind: 'share_existing', label: 'Team', agents: ['research'] });
  assert.equal(result.outcome, 'applied');
  assert.equal((await f.service.stores_change(input, f.admin)).outcome, 'applied');
  assert.equal((await f.service.stores_change({ ...input, change: { kind: 'use_own' } }, f.admin)).outcome, 'invalid');
  assert.equal((await f.service.stores_change_status({ requestId: input.requestId }, f.admin)).outcome, 'applied');
  assert.equal((await f.service.stores_change_status({ requestId: randomUUID() }, f.admin)).outcome, 'not-applied');
});

test('a crash between the config write and registry settlement reconciles to one outcome', async t => {
  const f = await fixture(t);
  await f.save('main', 'Seed');
  const original = f.api.runtime.config.mutateConfigFile;
  // The write persists, then the process "dies" before the registry settles.
  f.api.runtime.config.mutateConfigFile = async params => { await original(params); throw Error('process died'); };
  const { input, result } = await f.change('main', { kind: 'share_existing', label: 'Team', agents: ['research'] });
  f.api.runtime.config.mutateConfigFile = original;
  assert.equal(result.outcome, 'applied', 'the persisted write is recognized as applied');
  const restarted = createKnowledgeService(f.api);
  assert.equal((await restarted.stores_change_status({ requestId: input.requestId }, f.admin)).outcome, 'applied');
  assert.deepEqual((await restarted.records({}, f.as('research'))).records.map(r => r.title), ['Seed']);
});

test('a journaled change whose write never landed settles as not applied after restart', async t => {
  const f = await fixture(t);
  await f.save('main', 'Seed');
  // Reads (which abort inside mutate) still work; any write fails before persisting.
  f.api.runtime.config.mutateConfigFile = async ({ mutate }) => { await mutate(structuredClone(f.host.config), {}); throw Error('disk full'); };
  const { input, result } = await f.change('main', { kind: 'share_existing', label: 'Team', agents: ['research'] });
  assert.equal(result.outcome, 'not-applied', result.message);
  assert.equal((await f.service.stores_change_status({ requestId: input.requestId }, f.admin)).outcome, 'not-applied');
  assert.deepEqual(await f.titles('research'), []);
});

test('host publication lag after a save is not mistaken for an external edit', async t => {
  const f = await fixture(t, { lag: true });
  await f.save('main', 'Seed');
  assert.equal((await f.change('main', { kind: 'share_existing', label: 'Team', agents: ['research'] })).result.outcome, 'applied');
  // config.current() still shows the previous section until the host publishes.
  assert.deepEqual(await f.titles('research'), ['Seed']);
  f.publish();
  assert.deepEqual(await f.titles('research'), ['Seed']);
});

test('external configuration edits apply in-process; invalid membership makes affected agents unavailable', async t => {
  const f = await fixture(t);
  await f.save('main', 'Seed');
  await f.change('main', { kind: 'share_existing', label: 'Team', agents: ['research'] });
  f.host.config = structuredClone(f.host.config);
  f.host.config.plugins.entries.knowledge.config.stores.team.agents.push('ops');
  assert.deepEqual(await f.titles('ops'), ['Seed']);
  f.host.config = structuredClone(f.host.config);
  f.host.config.plugins.entries.knowledge.config.stores.other = { agents: ['ops'] };
  await assert.rejects(f.titles('ops'), /assignment is invalid/);
  const snap = await f.snapshot();
  assert.match(snap.agents.find(a => a.id === 'ops').issue, /more than one store/);
  assert.deepEqual(await f.titles('main'), ['Seed']);
});

test('the cutover fences old-assignment access before applying and after', async t => {
  const f = await fixture(t);
  await f.save('research', 'Research own');
  const stores = new Stores(f.api, { operatorRead: true, writesEnabled: true }, () => {});
  t.after(() => stores.stop());
  const principal = () => ({ agentId: 'research', scope: { visibility: 'private' } });
  const opened = await stores.open(principal, { provision: false });
  assert.equal(opened.kind, 'ready');
  opened.access.assertCurrent();
  let fencedDuringApply;
  f.host.config = structuredClone(f.host.config);
  f.host.config.plugins.entries.knowledge.config.stores = { team: { agents: ['research'] } };
  await stores.cutover(['research'], async () => {
    try { opened.access.assertCurrent(); fencedDuringApply = false; } catch { fencedDuringApply = true; }
    await stores.registry.call('reconcile', JSON.stringify({ team: { agents: ['research'] } }), storesRevision({ team: { agents: ['research'] } }));
  });
  assert.equal(fencedDuringApply, true, 'queued or in-flight work fails while the change applies');
  assert.throws(() => opened.access.assertCurrent(), /assignment changed/, 'old-assignment access never resumes');
  const next = await stores.open(principal, { provision: false });
  assert.equal(next.kind, 'unprovisioned', 'the new assignment resolves to the named store');
});

test('operator proxy is operator-only and validates inner operations', async t => {
  const f = await fixture(t);
  await f.save('research', 'Visible to operator');
  const rows = await f.service.agent_query({ agent: 'research', operation: 'records', input: {} }, f.reader);
  assert.deepEqual(rows.records.map(r => r.title), ['Visible to operator']);
  assert.equal((await f.service.records({}, f.reader)).total, 0, 'default operator view is the default agent');
  await assert.rejects(f.service.agent_query({ agent: 'research', operation: 'records', input: {} }, f.as('main')), /operator/);
  await assert.rejects(f.service.agent_query({ agent: 'research', operation: 'save_page', input: {} }, f.reader), /Unknown query/);
  await assert.rejects(f.service.agent_query({ agent: 'research', operation: 'stores_snapshot', input: {} }, f.reader), /Unknown query/);
  await assert.rejects(f.service.agent_query({ agent: 'ghost', operation: 'records', input: {} }, f.reader), /Unknown agent/);
  await assert.rejects(f.service.agent_query({ agent: 'research', operation: 'records', input: { bogus: 1 } }, f.reader), /Invalid input/);
  await assert.rejects(access(path.join(f.stateRoot, 'stores', 'nothing')));
});

test('recovery keeps a shared store bound to its data even when other edits conflict', async t => {
  const f = await fixture(t);
  await f.save('main', 'Seed');
  const original = f.api.runtime.config.mutateConfigFile;
  f.api.runtime.config.mutateConfigFile = async params => {
    await original(params);
    // Before settlement, someone else edits another part of the stores section.
    f.host.config = structuredClone(f.host.config);
    f.host.config.plugins.entries.knowledge.config.stores.other = { agents: ['ops'] };
    throw Error('process died');
  };
  const { result } = await f.change('main', { kind: 'share_existing', label: 'Team', agents: ['research'] });
  f.api.runtime.config.mutateConfigFile = original;
  assert.equal(result.outcome, 'conflict');
  assert.deepEqual(await createKnowledgeService(f.api).records({}, f.as('research')).then(r => r.records.map(x => x.title)), ['Seed']);
  assert.equal((await f.storesDir()).length, 1, 'no empty replacement store');
});

test('an emptied registry is recovery, never a fresh set of empty stores', async t => {
  const f = await fixture(t);
  await f.save('main', 'Kept');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(f.stateRoot, 'registry.sqlite'), '');
  await assert.rejects(createKnowledgeService(f.api).records({}, f.as('main')), /registry/);
  assert.equal((await f.storesDir()).length, 1);
});

test('operator provider reads never create storage', async t => {
  const f = await fixture(t);
  let runtime; const base = f.api;
  const service = createKnowledgeService({ ...base, registerMemoryCapability(c) { runtime = c.providerRuntime; } });
  const context = { authority: { kind: 'operator', connId: 'x', scopes: ['operator.read'] }, assertCurrent() {} };
  const { provider } = await runtime.open({ cfg: {}, agentId: 'research', context });
  await assert.rejects(provider.search({ query: 'anything' }), /first authorized use/);
  assert.equal((await provider.health()).status, 'ready');
  assert.deepEqual(await f.storesDir(), []);
  void service;
});
