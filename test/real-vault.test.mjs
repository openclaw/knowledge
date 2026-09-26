import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, mkdir, readFile, writeFile, rm, rename, link, symlink, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Check } from 'typebox/value';
import { SqliteIdentityStore } from '../dist/identity-store.js';
import { createKnowledgeService } from '../dist/service.js';
import { RealVault, parseVaultConfig } from '../dist/real-vault.js';
import { authorizeVault } from '../dist/access.js';
import { SAMPLE_ROOT } from '../dist/vault.js';
import { contract } from '../dist/contract.js';

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'knowledge-real-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'vault'); await mkdir(root);
  const sessionId = randomUUID();
  const manifest = { format: 'knowledge-vault-v1', vaultId: randomUUID(), agentId: 'main', generation: 0, publicationId: randomUUID() };
  await writeFile(path.join(root, 'vault.json'), JSON.stringify(manifest));
  const config = { root, statePath: path.join(base, 'knowledge.sqlite'), agentId: 'main', vaultId: manifest.vaultId, publicationId: manifest.publicationId, operatorRead: true };
  async function partition(relative, scope, title) {
    const target = path.join(root, relative); await mkdir(target, { recursive: true });
    await cp(SAMPLE_ROOT, target, { recursive: true });
    const { readdir } = await import('node:fs/promises');
    for (const file of await readdir(target, { recursive: true })) if (file.endsWith('.md')) {
      const full = path.join(target, file), raw = await readFile(full, 'utf8');
      await writeFile(full, raw.replace('visibility: sample', `visibility: ${scope.visibility}\n  agentId: main${scope.sessionId ? `\n  sessionId: ${scope.sessionId}` : ''}`).replaceAll('Alex Rivera', title));
    }
  }
  await partition('private', { visibility: 'agent-private' }, 'PRIVATE SENTINEL');
  await partition(`conversations/${sessionId}`, { visibility: 'conversation', sessionId }, 'SHARED SENTINEL');
  const store = new SqliteIdentityStore(config.statePath);
  let entry = { sessionId, chatType: 'direct' };
  const api = { pluginConfig: { vault: config }, runtime: { state: { openKeyedStore: () => store }, agent: { session: { getSessionEntry: () => entry } } } };
  const owner = { source: 'tool', api, tool: { agentId: 'main', sessionId, sessionKey: 'agent:main:test', senderIsOwner: true, assertInvocationCurrent() {} } };
  const operator = { source: 'session-action', api, action: { client: { connId: 'authenticated-connection', scopes: ['operator.read'] } } };
  return { root, base, config, manifest, sessionId, api, store, owner, operator, partition, setEntry: v => { entry = v; }, service: createKnowledgeService(api) };
}
const invokeAll = async (service, ctx) => Object.fromEntries(await Promise.all(Object.entries(service).filter(([name]) => ["status", "records", "record", "ontology", "diagnostics"].includes(name)).map(async ([name, op]) => [name, await op(name === 'record' ? { id: 'sample_person_alex' } : {}, ctx)])));

test('UI and owner-direct tool read identical private records through the same service', async t => {
  const f = await fixture(t);
  for (const ctx of [f.owner, f.operator]) {
    const output = await invokeAll(f.service, ctx);
    for (const [name, value] of Object.entries(output)) assert.ok(Check(contract.operations[name].output, value), name);
    assert.equal(output.status.sample, false); assert.equal(output.status.writesEnabled, false);
    assert.equal(output.status.scope, 'agent-private'); assert.equal(output.status.records, 7);
    assert.match(JSON.stringify(output), /PRIVATE SENTINEL/); assert.doesNotMatch(JSON.stringify(output), /SHARED SENTINEL/);
  }
  assert.deepEqual(await f.store.lookup('agent:main'), f.manifest);
});

test('group owner sees only its conversation: records, counts, evidence, ontology and diagnostics', async t => {
  const f = await fixture(t); f.setEntry({ sessionId: f.sessionId, chatType: 'group' });
  const before = await invokeAll(f.service, f.owner);
  assert.match(JSON.stringify(before), /SHARED SENTINEL/); assert.doesNotMatch(JSON.stringify(before), /PRIVATE SENTINEL/);
  // Changes in hidden scopes cannot change any authorized result except timestamps.
  await writeFile(path.join(f.root, 'private', 'secret.md'), 'PRIVATE INVALID SENTINEL');
  await f.partition(`conversations/${randomUUID()}`, { visibility: 'conversation', sessionId: randomUUID() }, 'OTHER CONVERSATION SENTINEL');
  const after = await invokeAll(f.service, f.owner);
  const stripTime = x => JSON.parse(JSON.stringify(x), (k, v) => ['checkedAt'].includes(k) ? undefined : v);
  assert.deepEqual(stripTime(after), stripTime(before));
  assert.equal((await f.service.record({ id: 'missing-private-id' }, f.owner)).record, null);
});

test('non-owner direct calls are conversation-scoped; missing chat authority fails closed', async t => {
  const f = await fixture(t);
  const nonowner = { ...f.owner, tool: { ...f.owner.tool, senderIsOwner: false } };
  assert.equal((await f.service.status({}, nonowner)).scope, `conversation:${f.sessionId}`);
  for (const chatType of [undefined, 'unknown']) {
    f.setEntry({ sessionId: f.sessionId, chatType });
    await assert.rejects(f.service.records({}, f.owner), /authority/);
  }
});

test('missing, foreign, stale, and revoked tool authority fails for every operation', async t => {
  const f = await fixture(t);
  for (const override of [{ agentId: 'other' }, { sessionId: randomUUID() }, { sessionKey: undefined }, { assertInvocationCurrent: undefined }, { assertInvocationCurrent() { throw Error('revoked'); } }]) {
    for (const [name, op] of Object.entries(f.service)) await assert.rejects(async () => op(name === 'record' ? { id: 'sample_person_alex' } : {}, { ...f.owner, tool: { ...f.owner.tool, ...override } }));
  }
  f.setEntry(undefined); await assert.rejects(f.service.records({}, f.owner));
});

test('operator scopes are explicit, selectors cannot create conversation authority', async t => {
  const f = await fixture(t);
  for (const action of [{}, { client: { scopes: ['operator.read'] } }, { client: { connId: 'x', scopes: [] } }, { ...f.operator.action, agentId: 'other' }, { ...f.operator.action, sessionKey: f.owner.tool.sessionKey }]) {
    await assert.rejects(f.service.records({}, { ...f.operator, action }));
  }
  const restricted = createKnowledgeService({ ...f.api, pluginConfig: { vault: { ...f.config, operatorRead: false } } });
  await assert.rejects(restricted.records({}, f.operator));
  for (const fields of [{ root: f.root }, { agentId: 'main' }, { sessionId: f.sessionId }, { scope: 'agent-private' }]) assert.equal(Check(contract.operations.records.input, fields), false);
});

test('empty conversation scope returns an empty catalog, without creating files or reading private ontology', async t => {
  const f = await fixture(t), sessionId = randomUUID();
  f.setEntry({ sessionId, chatType: 'channel' });
  const ctx = { ...f.owner, tool: { ...f.owner.tool, sessionId } };
  const output = await invokeAll(f.service, ctx);
  assert.equal(output.status.records, 0); assert.equal(output.record.record, null); assert.equal(output.diagnostics.total, 0);
  assert.equal(output.ontology.available, true); assert.doesNotMatch(JSON.stringify(output), /PRIVATE SENTINEL/);
  await assert.rejects(access(path.join(f.root, 'conversations', sessionId)));
});

test('mismatched scope content is withheld, malformed files preserved', async t => {
  const f = await fixture(t);
  const file = path.join(f.root, 'private', 'people', 'alex-rivera.md'), raw = await readFile(file, 'utf8');
  await writeFile(file, raw.replace('agentId: main', 'agentId: other'));
  const output = await invokeAll(f.service, f.owner);
  assert.equal(output.record.record, null); assert.doesNotMatch(JSON.stringify(output), /PRIVATE SENTINEL/);
  assert.equal(await readFile(file, 'utf8'), raw.replace('agentId: main', 'agentId: other'));
});

test('identity replacement, generation rollback/mismatch, and missing manifest never fall back to sample', async t => {
  const f = await fixture(t); await f.service.status({}, f.owner);
  for (const change of [{ vaultId: randomUUID() }, { publicationId: randomUUID() }, { generation: 1 }, { agentId: 'other' }, { format: 'unknown' }]) {
    await writeFile(path.join(f.root, 'vault.json'), JSON.stringify({ ...f.manifest, ...change }));
    await assert.rejects(f.service.records({}, f.owner), /identity/);
    await assert.rejects(createKnowledgeService(f.api).records({}, f.owner), /identity/);
  }
  await rename(path.join(f.root, 'vault.json'), path.join(f.root, 'old-vault.json'));
  await assert.rejects(f.service.records({}, f.owner), /identity/);
});

test('retained checkpoint fences a replaced vault even after config change and service restart', async t => {
  const f = await fixture(t); await f.service.status({}, f.owner);
  const replacement = { ...f.manifest, vaultId: randomUUID(), publicationId: randomUUID() };
  await writeFile(path.join(f.root, 'vault.json'), JSON.stringify(replacement));
  const api = { ...f.api, pluginConfig: { vault: { ...f.config, vaultId: replacement.vaultId, publicationId: replacement.publicationId } } };
  await assert.rejects(createKnowledgeService(api).records({}, { ...f.owner, api }), /identity/);
  assert.equal((await f.store.lookup('agent:main')).vaultId, f.manifest.vaultId);
});

test('moving the same vault preserves identity, reordered manifest keys are immaterial', async t => {
  const f = await fixture(t); await f.service.status({}, f.owner);
  const moved = path.join(f.base, 'moved'); await rename(f.root, moved);
  await writeFile(path.join(moved, 'vault.json'), JSON.stringify(Object.fromEntries(Object.entries(f.manifest).reverse())));
  const api = { ...f.api, pluginConfig: { vault: { ...f.config, root: moved } } };
  assert.equal((await createKnowledgeService(api).status({}, { ...f.owner, api })).vault, f.manifest.vaultId);
});

test('authority and identity are rechecked after asynchronous reads', async t => {
  const f = await fixture(t), real = new RealVault(f.config, f.store);
  await assert.rejects(real.run(authorizeVault(f.owner, 'main', true), async vault => {
    const result = await vault.list({}); f.setEntry({ sessionId: f.sessionId, chatType: 'group' }); return result;
  }), /authority/);
  f.setEntry({ sessionId: f.sessionId, chatType: 'direct' });
  await assert.rejects(real.run(authorizeVault(f.owner, 'main', true), async vault => {
    const result = await vault.list({}); await writeFile(path.join(f.root, 'vault.json'), JSON.stringify({ ...f.manifest, publicationId: randomUUID() })); return result;
  }), /identity/);
});

test('hardlinks, file and partition symlinks cannot expose another scope', async t => {
  const f = await fixture(t), shared = path.join(f.root, 'conversations', f.sessionId);
  await link(path.join(f.root, 'private', 'people', 'alex-rivera.md'), path.join(shared, 'leak.md'));
  await symlink(path.join(f.root, 'private'), path.join(shared, 'leak-dir'));
  await symlink(path.join(f.root, 'private', 'people', 'alex-rivera.md'), path.join(shared, 'leak-file.md'));
  f.setEntry({ sessionId: f.sessionId, chatType: 'group' });
  assert.doesNotMatch(JSON.stringify(await invokeAll(f.service, f.owner)), /PRIVATE SENTINEL/);
  await rename(shared, shared + '-saved'); await symlink(path.join(f.root, 'private'), shared);
  await assert.rejects(f.service.records({}, f.owner), /identity/);
});

test('external edits, renames, and deletion appear on next read without changing authored files', async t => {
  const f = await fixture(t), file = path.join(f.root, 'private', 'people', 'alex-rivera.md');
  const before = await f.service.record({ id: 'sample_person_alex' }, f.owner);
  const raw = (await readFile(file, 'utf8')).replace('PRIVATE SENTINEL', 'Edited name');
  await writeFile(file, raw); await rename(file, file + '-renamed.md');
  const after = await f.service.record({ id: 'sample_person_alex' }, f.owner);
  assert.equal(after.record.id, before.record.id); assert.notEqual(after.record.hash, before.record.hash); assert.equal((await f.service.record({id:'sample_person_alex',view:'raw'},f.owner)).record.raw, raw);
  await rm(file + '-renamed.md'); assert.equal((await f.service.record({ id: 'sample_person_alex' }, f.owner)).record, null);
});

test('invalid real-vault configuration fails closed', () => {
  assert.equal(parseVaultConfig({}), undefined);
  for (const config of [{ vault: {} }, { vault: null }, { unrelated: true }]) assert.throws(() => parseVaultConfig(config));
});

test('identity bindings persist across connections and competing registrations never replace them', async t => {
  const f = await fixture(t), rival = { ...f.manifest, publicationId: randomUUID() };
  const results = await Promise.all([f.store.registerIfAbsent('agent:main', f.manifest), new SqliteIdentityStore(f.config.statePath).registerIfAbsent('agent:main', rival)]);
  assert.deepEqual(results, [true, false]);
  assert.deepEqual(await new SqliteIdentityStore(f.config.statePath).lookup('agent:main'), f.manifest);
});

test('unrelated/corrupt operational databases and database links fail closed without replacement', async t => {
  const f = await fixture(t);
  await writeFile(f.config.statePath, 'unrelated content');
  await assert.rejects(f.service.status({}, f.owner));
  assert.equal(await readFile(f.config.statePath, 'utf8'), 'unrelated content');
  await rename(f.config.statePath, f.config.statePath + '.saved');
  await symlink(f.config.statePath + '.saved', f.config.statePath);
  await assert.rejects(f.service.status({}, f.owner));
  assert.equal(await readFile(f.config.statePath + '.saved', 'utf8'), 'unrelated content');
});

test('build metadata retains the real-vault configuration contract', async () => {
  const { default: entry } = await import('../dist/index.js');
  const { getToolPluginMetadata } = await import('openclaw/plugin-sdk/tool-plugin');
  assert.ok(entry.configSchema.jsonSchema.properties.vault.properties.statePath);
  assert.deepEqual(getToolPluginMetadata(entry).configSchema, entry.configSchema.jsonSchema);
  assert.equal(getToolPluginMetadata(entry).tools.length, 23);
});


test('all opt-in inspection views retain conversation scope and authority', async t => {
  const f = await fixture(t); f.setEntry({ sessionId: f.sessionId, chatType: 'group' });
  for (const input of [{id:'sample_person_alex',view:'raw'}, {id:'sample_person_alex',includeMetadata:true,includeReferences:true}]) {
    const result = await f.service.record(input, f.owner);
    assert.ok(Check(contract.operations.record.output, result));
    assert.match(JSON.stringify(result), /SHARED SENTINEL/); assert.doesNotMatch(JSON.stringify(result), /PRIVATE SENTINEL/);
  }
  await writeFile(path.join(f.root,'private','ontology.yaml'),'PRIVATE BROKEN ONTOLOGY');
  for (const input of [{view:'definitions',includeRecords:true}, {view:'sources'}, {view:'diagnostics'}]) {
    const result = await f.service.ontology(input, f.owner);
    assert.ok(Check(contract.operations.ontology.output,result)); assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  }
  await assert.rejects(f.service.ontology({view:'sources',sourcePath:'../private/ontology.yaml'},f.owner), /unavailable/);
});
