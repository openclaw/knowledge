import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { authorizeVault, authorizeMemoryAccess } from '../dist/access.js';
import { createKnowledgeService } from '../dist/service.js';

function authority(audience) {
  if (arguments.length === 0) audience = { kind: 'owner-private', agentId: 'main' };
  let invocationActive = true, audienceActive = true;
  const api = {};
  const assertInvocationCurrent = () => { if (!invocationActive) throw Error('invocation revoked'); };
  const assertMemoryAudienceCurrent = () => { if (!audienceActive) throw Error('audience revoked'); };
  const tool = { source: 'tool', api, tool: {
    agentId: 'main', memoryAudience: audience, assertInvocationCurrent, assertMemoryAudienceCurrent,
  } };
  const memory = { authority: {
    kind: 'session', sessionKey: 'agent:main:test', sessionId: randomUUID(), sandboxed: false, audience,
  }, assertCurrent() { assertInvocationCurrent(); assertMemoryAudienceCurrent(); } };
  return {
    api, tool, memory,
    access: () => authorizeVault(tool, 'main', true, true),
    revokeInvocation() { invocationActive = false; },
    revokeAudience() { audienceActive = false; },
  };
}

test('host audiences map identically for native tools and provider access', () => {
  const sessionId = randomUUID();
  for (const [audience, expected] of [
    [{ kind: 'owner-private', agentId: 'main' }, { visibility: 'agent-private', agentId: 'main' }],
    [{ kind: 'conversation', agentId: 'main', sessionKey: 'agent:main:group', sessionId },
      { visibility: 'conversation', agentId: 'main', sessionId }],
  ]) {
    const f = authority(audience);
    assert.deepEqual(f.access().scope, expected);
    assert.deepEqual(authorizeMemoryAccess(f.memory, 'main', 'main', true).scope, expected);
  }
});

test('missing, foreign, sandboxed, host, and revoked authority is denied', () => {
  for (const audience of [undefined, { kind: 'owner-private', agentId: 'other' }]) {
    const f = authority(audience);
    assert.throws(f.access, /authority/);
    assert.throws(() => authorizeMemoryAccess(f.memory, 'main', 'main', true), /authority/);
  }
  const sandboxed = authority(); sandboxed.memory.authority.sandboxed = true;
  assert.throws(() => authorizeMemoryAccess(sandboxed.memory, 'main', 'main', true), /authority/);
  const host = authority(); host.memory.authority = { kind: 'host', operation: 'bootstrap' };
  assert.throws(() => authorizeMemoryAccess(host.memory, 'main', 'main', true), /authority/);
  for (const revoke of ['revokeInvocation', 'revokeAudience']) {
    const f = authority(), access = f.access();
    f[revoke]();
    assert.throws(access.assertCurrent, /revoked/);
  }
});

async function serviceFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'knowledge-audience-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = path.join(root, 'vault'), sessionId = randomUUID();
  await mkdir(path.join(vault, 'private'), { recursive: true });
  await mkdir(path.join(vault, 'conversations', sessionId), { recursive: true });
  const vaultId = randomUUID(), publicationId = randomUUID();
  await writeFile(path.join(vault, 'vault.json'), JSON.stringify({
    format: 'knowledge-vault-v1', vaultId, agentId: 'main', generation: 0, publicationId,
  }));
  const owner = authority({ kind: 'owner-private', agentId: 'main' });
  const conversation = authority({
    kind: 'conversation', agentId: 'main', sessionKey: 'agent:main:group', sessionId,
  });
  const config = { root: vault, statePath: path.join(root, 'knowledge.sqlite'), vaultId,
    publicationId, agentId: 'main', writesEnabled: true, operatorRead: true };
  let memory;
  const api = { pluginConfig: { vault: config }, registerMemoryCapability(c) { memory = c.providerRuntime; } };
  owner.tool.api = api; conversation.tool.api = api;
  const service = createKnowledgeService(api);
  const save = (title, context) => service.save_page({ requestId: randomUUID(), expectedVaultId: vaultId,
    type: 'note', title, body: 'Synthetic host-audience regression evidence.' }, context.tool);
  return { owner, conversation, service, save, open: context => memory.open({ cfg: {}, agentId: 'main', context: context.memory }) };
}

test('owner-private and conversation audiences remain partition-isolated', async t => {
  const f = await serviceFixture(t);
  const privateRecord = await f.save('Private sentinel', f.owner);
  const conversationRecord = await f.save('Conversation sentinel', f.conversation);
  assert.equal((await f.service.record({ id: privateRecord.id }, f.conversation.tool)).record, null);
  assert.equal((await f.service.record({ id: conversationRecord.id }, f.owner.tool)).record, null);
  const { provider } = await f.open(f.conversation);
  const hits = await provider.search({ query: 'sentinel' });
  assert.deepEqual(hits.hits.map(hit => hit.reference.id), [conversationRecord.id]);
  await provider.close();
});

test('audience revocation stops retained reads and new writes', async t => {
  const f = await serviceFixture(t);
  await f.save('Private sentinel', f.owner);
  const { provider } = await f.open(f.owner);
  f.owner.revokeAudience();
  await assert.rejects(provider.search({ query: 'sentinel' }), /audience revoked/);
  await assert.rejects(f.save('Must not publish', f.owner), /audience revoked/);
});
