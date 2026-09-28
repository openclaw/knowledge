import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { authorizeVault, authorizeMemoryAccess } from '../dist/access.js';
import { createKnowledgeService } from '../dist/service.js';

function authority() {
  const parentKey = 'agent:main:parent', childKey = 'agent:main:subagent:child';
  const parent = { sessionId: randomUUID(), lifecycleRevision: randomUUID(), chatType: 'direct' };
  const child = { sessionId: randomUUID(), lifecycleRevision: randomUUID(), spawnedBy: parentKey,
    parentSessionKey: parentKey, parentSessionId: parent.sessionId, parentSessionLifecycleRevision: parent.lifecycleRevision,
    spawnedBySenderIsOwner: true };
  const entries = new Map([[parentKey, parent], [childKey, child]]);
  let active = true;
  const api = { runtime: { agent: { session: { getSessionEntry({ agentId, sessionKey, readConsistency }) {
    assert.equal(agentId, 'main'); assert.equal(readConsistency, 'latest'); return entries.get(sessionKey);
  } } } } };
  const current = () => { if (!active) throw Error('invocation revoked'); };
  const tool = { source: 'tool', api, tool: { agentId: 'main', sessionKey: childKey, sessionId: child.sessionId,
    senderIsOwner: true, assertInvocationCurrent: current } };
  const memory = { authority: { kind: 'session', sessionKey: childKey, sessionId: child.sessionId,
    senderIsOwner: true, sandboxed: false }, assertCurrent: current };
  const access = () => authorizeVault(tool, 'main', true, true);
  return { parentKey, childKey, parent, child, entries, api, tool, memory, access, revoke() { active = false; } };
}

test('child and nested child inherit exact owner or conversation scope, never launch ownership', () => {
  for (const chatType of ['direct', 'group', 'channel']) for (const owner of [true, false]) {
    const f = authority(); f.parent.chatType = chatType; f.child.spawnedBySenderIsOwner = owner;
    // A synthetic owner launch must not upgrade a non-owner or group parent.
    f.tool.tool.senderIsOwner = !owner;
    const expected = chatType === 'direct' && owner ? { visibility: 'agent-private', agentId: 'main' }
      : { visibility: 'conversation', agentId: 'main', sessionId: f.parent.sessionId };
    assert.deepEqual(f.access().scope, expected);
    assert.deepEqual(authorizeMemoryAccess(f.api, f.memory, 'main', 'main', true).scope, expected);
    const nestedKey = 'agent:main:subagent:nested', nestedId = randomUUID();
    f.entries.set(nestedKey, { sessionId: nestedId, spawnedBy: f.childKey, parentSessionKey: f.childKey,
      parentSessionId: f.child.sessionId, parentSessionLifecycleRevision: f.child.lifecycleRevision,
      spawnedBySenderIsOwner: true, chatType: 'direct' });
    f.tool.tool.sessionKey = nestedKey; f.tool.tool.sessionId = nestedId;
    assert.deepEqual(f.access().scope, expected);
  }
});

test('unstamped, broken, foreign and cyclic child lineage cannot grant access', () => {
  const mutations = [
    f => { delete f.child.spawnedBySenderIsOwner; },
    f => { delete f.child.parentSessionId; },
    f => { f.child.parentSessionId = randomUUID(); },
    f => { f.parent.lifecycleRevision = randomUUID(); },
    f => { f.child.parentSessionKey = 'agent:main:unrelated'; },
    f => { f.entries.delete(f.parentKey); },
    f => { f.parent.chatType = undefined; },
    f => { f.child.spawnedBy = f.child.parentSessionKey = 'agent:foreign:parent'; },
    f => { f.child.spawnedBy = f.child.parentSessionKey = f.childKey; f.child.parentSessionId = f.child.sessionId; },
    f => { f.tool.tool.sessionId = randomUUID(); f.memory.authority.sessionId = randomUUID(); },
  ];
  for (const mutate of mutations) {
    const f = authority(); mutate(f);
    assert.throws(f.access, /authority/);
    assert.throws(() => authorizeMemoryAccess(f.api, f.memory, 'main', 'main', true), /authority/);
  }
  const f = authority(); f.memory.authority.sandboxed = true;
  assert.throws(() => authorizeMemoryAccess(f.api, f.memory, 'main', 'main', true), /authority/);
});

test('a legacy parent without a lifecycle revision may delegate, but later rotation invalidates it', () => {
  const f = authority(); delete f.parent.lifecycleRevision; delete f.child.parentSessionLifecycleRevision;
  assert.equal(f.access().scope.visibility, 'agent-private');
  f.parent.lifecycleRevision = randomUUID();
  assert.throws(f.access, /authority/);
});

test('resetting only the worker fences old calls without changing its inherited parent scope', () => {
  const f = authority(), old = f.access();
  f.child.lifecycleRevision = randomUUID();
  assert.throws(old.assertCurrent, /authority/);
  assert.equal(f.access().scope.visibility, 'agent-private');
  f.parent.lifecycleRevision = randomUUID();
  assert.throws(f.access, /authority/);
});

test('retained child capabilities recheck all ancestors, even when resulting scope stays private', () => {
  for (const mutate of [
    f => { f.parent.sessionId = randomUUID(); },
    f => { f.parent.lifecycleRevision = randomUUID(); },
    f => { f.child.lifecycleRevision = randomUUID(); },
    f => { f.parent.chatType = 'group'; },
    f => { f.child.spawnedBySenderIsOwner = false; },
    f => { f.child.spawnedBy = f.child.parentSessionKey = 'agent:main:other'; f.entries.set('agent:main:other', f.parent); },
    f => { f.entries.delete(f.parentKey); },
    f => f.revoke(),
  ]) {
    const f = authority(), access = f.access(), memory = authorizeMemoryAccess(f.api, f.memory, 'main', 'main', true);
    access.assertCurrent(); memory.assertCurrent(); mutate(f);
    assert.throws(access.assertCurrent, /authority|revoked/);
    assert.throws(memory.assertCurrent, /authority|revoked/);
  }
});

async function serviceFixture(t) {
  const f = authority(), root = await mkdtemp(path.join(os.tmpdir(), 'knowledge-delegation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = path.join(root, 'vault'); await mkdir(vault);
  await mkdir(path.join(vault, 'private'));
  await mkdir(path.join(vault, 'conversations', f.parent.sessionId), { recursive: true });
  const vaultId = randomUUID(), publicationId = randomUUID();
  await writeFile(path.join(vault, 'vault.json'), JSON.stringify({ format: 'knowledge-vault-v1', vaultId,
    agentId: 'main', generation: 0, publicationId }));
  f.api.pluginConfig = { vault: { root: vault, statePath: path.join(root, 'knowledge.sqlite'), vaultId,
    publicationId, agentId: 'main', writesEnabled: true, operatorRead: true } };
  let memory;
  f.api.registerMemoryCapability = c => { memory = c.providerRuntime; };
  const service = createKnowledgeService(f.api);
  const parentTool = { ...f.tool, tool: { ...f.tool.tool, sessionKey: f.parentKey, sessionId: f.parent.sessionId } };
  const save = (title, context = f.tool) => service.save_page({ requestId: randomUUID(), expectedVaultId: vaultId,
    type: 'note', title, body: 'Synthetic delegation regression evidence.' }, context);
  return { ...f, service, parentTool, save, open: () => memory.open({ cfg: {}, agentId: 'main', context: f.memory }) };
}

test('real child tools read and publish in the parent vault; shared-memory reads agree', async t => {
  const f = await serviceFixture(t);
  const saved = await f.save('Delegation private sentinel');
  assert.equal((await f.service.status({}, f.tool)).scope, 'agent-private');
  assert.equal((await f.service.record({ id: saved.id }, f.parentTool)).record.id, saved.id);
  const { provider } = await f.open();
  assert.equal((await provider.search({ query: 'sentinel' })).hits.length, 1);
  // Scope fences run after asynchronous work as well as before dispatch.
  const pending = provider.search({ query: 'sentinel' }); f.parent.sessionId = randomUUID();
  await assert.rejects(pending, /authority/); await provider.close();
  await assert.rejects(f.save('Must not publish'), /authority/);
});

test('group and non-owner children share only the parent conversation, including writes', async t => {
  for (const chatType of ['group', 'direct']) {
    const f = await serviceFixture(t);
    const privateNote = await f.save('Private sentinel', f.parentTool);
    f.parent.chatType = chatType;
    f.child.spawnedBySenderIsOwner = chatType === 'group';
    f.parentTool.tool.senderIsOwner = chatType === 'group';
    assert.equal((await f.service.status({}, f.tool)).scope, `conversation:${f.parent.sessionId}`);
    assert.equal((await f.service.record({ id: privateNote.id }, f.tool)).record, null);
    const shared = await f.save('Shared sentinel');
    assert.equal((await f.service.record({ id: shared.id }, f.parentTool)).record.id, shared.id);
    const { provider } = await f.open();
    const hits = (await provider.search({ query: 'sentinel' })).hits;
    assert.deepEqual(hits.map(h => h.reference.id), [shared.id]);
    await provider.close();
  }
});
