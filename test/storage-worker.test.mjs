import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createKnowledgeService } from '../dist/service.js';

// Storage runs in a worker; authority checks it makes mid-operation are answered
// by the main thread. Revoking there must stop the write before it publishes.
test('authority revoked during a worker operation fails the write and publishes nothing', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'knowledge-worker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vaultId = randomUUID(), publicationId = randomUUID(), sessionId = randomUUID();
  await mkdir(path.join(root, 'private'));
  await writeFile(path.join(root, 'vault.json'), JSON.stringify({ format: 'knowledge-vault-v1', vaultId, agentId: 'main', generation: 0, publicationId }));
  const statePath = path.join(root, '..', `${path.basename(root)}.sqlite`); t.after(() => rm(statePath, { force: true }));
  const api = { pluginConfig: { vault: { root, statePath, vaultId, publicationId, agentId: 'main', operatorRead: true, writesEnabled: true } }, registerService() {},
    runtime: { agent: { session: { getSessionEntry() { return { sessionId, chatType: 'direct' }; } } } } };
  const service = createKnowledgeService(api);
  let checks = 0, allowed = Infinity;
  const tool = { source: 'tool', api, tool: { agentId: 'main', sessionKey: 'agent:main:test', sessionId, senderIsOwner: true,
    assertInvocationCurrent() { if (++checks > allowed) throw Error('invocation revoked'); } } };
  const save = title => service.save_page({ requestId: randomUUID(), expectedVaultId: vaultId, type: 'note', title, body: 'Body' }, tool);

  await save('Warm up');
  const perSave = checks; assert.ok(perSave > 2, 'the worker re-checks authority during a write');
  // Allow only the main thread's checks before dispatch; the first worker-side check revokes.
  checks = 0; allowed = 2;
  await assert.rejects(save('Revoked mid-write'), /invocation revoked/);
  allowed = Infinity;
  const notes = await readdir(path.join(root, 'private', 'notes'));
  assert.equal(notes.filter(name => name.startsWith('revoked')).length, 0, 'nothing published after revocation');
  assert.equal((await service.lookup({ query: 'Revoked mid-write' }, tool)).total, 0);
  assert.equal((await service.lookup({ query: 'Warm up' }, tool)).total, 1);
});
