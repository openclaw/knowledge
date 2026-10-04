import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, mkdir, readFile, writeFile, rm, rename, link, symlink, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Check } from 'typebox/value';
import { SqliteIdentityStore } from '../dist/identity-store.js';
import { createKnowledgeService } from '../dist/service.js';
import { RealVault } from '../dist/real-vault.js';
import { accessFor, apiFor } from './support.mjs';
import { SAMPLE_ROOT } from '../dist/vault.js';
import { contract } from '../dist/contract.js';

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'knowledge-real-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'vault'); await mkdir(root);
  const sessionId = randomUUID();
  const manifest = { format: 'knowledge-vault-v2', vaultId: randomUUID(), generation: 0, publicationId: randomUUID() };
  await writeFile(path.join(root, 'vault.json'), JSON.stringify(manifest));
  const config = { root, statePath: path.join(base, 'knowledge.sqlite'), vaultId: manifest.vaultId, publicationId: manifest.publicationId, operatorRead: true };
  async function partition(relative, scope, title) {
    const target = path.join(root, relative); await mkdir(target, { recursive: true });
    await cp(SAMPLE_ROOT, target, { recursive: true });
    const { readdir } = await import('node:fs/promises');
    for (const file of await readdir(target, { recursive: true })) if (file.endsWith('.md')) {
      const full = path.join(target, file), raw = await readFile(full, 'utf8');
      await writeFile(full, raw.replace('visibility: sample', `visibility: ${scope.visibility}${scope.sessionId ? `\n  sessionId: ${scope.sessionId}` : ''}`).replaceAll('Alex Rivera', title));
    }
  }
  await partition('private', { visibility: 'private' }, 'PRIVATE SENTINEL');
  await partition(`conversations/${sessionId}`, { visibility: 'conversation', sessionId }, 'SHARED SENTINEL');
  const store = new SqliteIdentityStore(config.statePath);
  const api = apiFor(base, config, { agents: ['main', 'other'] });
  const owner = { source: 'tool', api, tool: { agentId: 'main', memoryAudience: { kind: 'owner-private', agentId: 'main' }, assertInvocationCurrent() {}, assertMemoryAudienceCurrent() {} } };
  const operator = { source: 'session-action', api, action: { client: { connId: 'authenticated-connection', scopes: ['operator.read'] } } };
  const setAudience = audience => { owner.tool.memoryAudience = audience; };
  return { root, base, config, manifest, sessionId, api, store, owner, operator, partition, setAudience, service: createKnowledgeService(api) };
}
const invokeAll = async (service, ctx) => Object.fromEntries(await Promise.all(Object.entries(service).filter(([name]) => ["status", "records", "record", "ontology", "diagnostics"].includes(name)).map(async ([name, op]) => [name, await op(name === 'record' ? { id: 'sample_person_alex' } : {}, ctx)])));

test('UI and owner-private tool read identical private records through the same service', async t => {
  const f = await fixture(t);
  for (const ctx of [f.owner, f.operator]) {
    const output = await invokeAll(f.service, ctx);
    for (const [name, value] of Object.entries(output)) assert.ok(Check(contract.operations[name].output, value), name);
    assert.equal(output.status.store, 'ready'); assert.equal(output.status.writesEnabled, false);
    assert.equal(output.status.scope, 'private'); assert.equal(output.status.records, 7);
    assert.match(JSON.stringify(output), /PRIVATE SENTINEL/); assert.doesNotMatch(JSON.stringify(output), /SHARED SENTINEL/);
  }
  assert.deepEqual(await f.store.lookup(`store:${f.manifest.vaultId}`), f.manifest);
});

test('conversation audience sees only its records, counts, evidence, ontology and diagnostics', async t => {
  const f = await fixture(t); f.setAudience({ kind: 'conversation', agentId: 'main', sessionKey: 'agent:main:group', sessionId: f.sessionId });
  const before = await invokeAll(f.service, f.owner);
  assert.match(JSON.stringify(before), /SHARED SENTINEL/); assert.doesNotMatch(JSON.stringify(before), /PRIVATE SENTINEL/);
  // Changes in hidden scopes cannot change any authorized result except timestamps.
  await writeFile(path.join(f.root, 'private', 'secret.md'), 'PRIVATE INVALID SENTINEL');
  await f.partition(`conversations/${randomUUID()}`, { visibility: 'conversation', sessionId: randomUUID() }, 'OTHER CONVERSATION SENTINEL');
  const after = await invokeAll(f.service, f.owner);
  const stripTime = x => JSON.parse(JSON.stringify(x), (k, v) => ['checkedAt', 'queriedAt', 'scannedAt', 'indexedAt'].includes(k) ? undefined : v);
  assert.deepEqual(stripTime(after), stripTime(before));
  assert.equal((await f.service.record({ id: 'missing-private-id' }, f.owner)).record, null);
});

test('host-resolved conversation calls are scoped; missing audience fails closed', async t => {
  const f = await fixture(t);
  const nonowner = { ...f.owner, tool: { ...f.owner.tool, memoryAudience: { kind: 'conversation', agentId: 'main', sessionKey: 'agent:main:direct', sessionId: f.sessionId } } };
  assert.equal((await f.service.status({}, nonowner)).scope, `conversation:${f.sessionId}`);
  const missing = { ...f.owner, tool: { ...f.owner.tool, memoryAudience: undefined } };
  await assert.rejects(f.service.records({}, missing), /authority/);
});

test('missing, foreign, and revoked tool authority fails for every operation', async t => {
  const f = await fixture(t);
  for (const override of [{ memoryAudience: undefined }, { assertInvocationCurrent: undefined }, { assertInvocationCurrent() { throw Error('revoked'); } }, { assertMemoryAudienceCurrent() { throw Error('audience revoked'); } }]) {
    for (const [name, op] of Object.entries(f.service)) await assert.rejects(async () => op(name === 'record' ? { id: 'sample_person_alex' } : {}, { ...f.owner, tool: { ...f.owner.tool, ...override } }));
  }
});

test("another agent's audience resolves only that agent's own store", async t => {
  const f = await fixture(t);
  const other = { ...f.owner, tool: { ...f.owner.tool, memoryAudience: { kind: 'owner-private', agentId: 'other' } } };
  assert.equal((await f.service.records({}, other)).total, 0);
  assert.doesNotMatch(JSON.stringify(await f.service.grep({ query: 'SENTINEL' }, other)), /PRIVATE SENTINEL/);
  assert.equal((await f.service.records({}, f.owner)).total > 0, true);
});

test('operator scopes are explicit, selectors cannot create conversation authority', async t => {
  const f = await fixture(t);
  for (const action of [{}, { client: { scopes: ['operator.read'] } }, { client: { connId: 'x', scopes: [] } }, { ...f.operator.action, sessionKey: 'agent:main:selected' }]) {
    await assert.rejects(f.service.records({}, { ...f.operator, action }));
  }
  const restricted = createKnowledgeService({ ...f.api, pluginConfig: { operatorRead: false } });
  await assert.rejects(restricted.records({}, f.operator));
  for (const fields of [{ root: f.root }, { agentId: 'main' }, { sessionId: f.sessionId }, { scope: 'agent-private' }]) assert.equal(Check(contract.operations.records.input, fields), false);
});

test('empty conversation scope returns an empty catalog, without creating files or reading private ontology', async t => {
  const f = await fixture(t), sessionId = randomUUID();
  const ctx = { ...f.owner, tool: { ...f.owner.tool, memoryAudience: { kind: 'conversation', agentId: 'main', sessionKey: 'agent:main:channel', sessionId } } };
  const output = await invokeAll(f.service, ctx);
  assert.equal(output.status.records, 0); assert.equal(output.record.record, null); assert.equal(output.diagnostics.total, 0);
  assert.equal(output.ontology.available, true); assert.doesNotMatch(JSON.stringify(output), /PRIVATE SENTINEL/);
  await assert.rejects(access(path.join(f.root, 'conversations', sessionId)));
});

test('mismatched scope content is withheld, malformed files preserved', async t => {
  const f = await fixture(t);
  const file = path.join(f.root, 'private', 'people', 'alex-rivera.md'), raw = await readFile(file, 'utf8');
  const foreign = raw.replace('visibility: private', `visibility: conversation\n  sessionId: ${f.sessionId}`);
  await writeFile(file, foreign);
  const output = await invokeAll(f.service, f.owner);
  assert.equal(output.record.record, null); assert.doesNotMatch(JSON.stringify(output), /PRIVATE SENTINEL/);
  assert.equal(await readFile(file, 'utf8'), foreign);
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

test('the registry identity fences a replaced vault across service restarts', async t => {
  const f = await fixture(t); await f.service.status({}, f.owner);
  const replacement = { ...f.manifest, vaultId: randomUUID(), publicationId: randomUUID() };
  await writeFile(path.join(f.root, 'vault.json'), JSON.stringify(replacement));
  await assert.rejects(createKnowledgeService(f.api).records({}, f.owner), /identity/);
  assert.equal((await f.store.lookup(`store:${f.manifest.vaultId}`)).vaultId, f.manifest.vaultId);
});

test('a moved store is unavailable, never replaced; reordered manifest keys are immaterial', async t => {
  const f = await fixture(t); await f.service.status({}, f.owner);
  const moved = path.join(f.base, 'moved'); await rename(f.root, moved);
  const status = await createKnowledgeService(f.api).status({}, f.owner);
  assert.equal(status.store, 'unavailable'); assert.equal(status.vault, '');
  await assert.rejects(createKnowledgeService(f.api).records({}, f.owner), /identity/);
  await rename(moved, f.root);
  await writeFile(path.join(f.root, 'vault.json'), JSON.stringify(Object.fromEntries(Object.entries(f.manifest).reverse())));
  assert.equal((await createKnowledgeService(f.api).status({}, f.owner)).vault, f.manifest.vaultId);
});

test('authority and identity are rechecked after asynchronous reads', async t => {
  const f = await fixture(t), real = new RealVault(f.config, f.store);
  await assert.rejects(real.run(accessFor(f.owner), async vault => {
    const result = await vault.list({}); f.setAudience({ kind: 'conversation', agentId: 'main', sessionKey: 'agent:main:group', sessionId: f.sessionId }); return result;
  }), /authority/);
  f.setAudience({ kind: 'owner-private', agentId: 'main' });
  await assert.rejects(real.run(accessFor(f.owner), async vault => {
    const result = await vault.list({}); await writeFile(path.join(f.root, 'vault.json'), JSON.stringify({ ...f.manifest, publicationId: randomUUID() })); return result;
  }), /identity/);
});

test('hardlinks, file and partition symlinks cannot expose another scope', async t => {
  const f = await fixture(t), shared = path.join(f.root, 'conversations', f.sessionId);
  await link(path.join(f.root, 'private', 'people', 'alex-rivera.md'), path.join(shared, 'leak.md'));
  await symlink(path.join(f.root, 'private'), path.join(shared, 'leak-dir'));
  await symlink(path.join(f.root, 'private', 'people', 'alex-rivera.md'), path.join(shared, 'leak-file.md'));
  f.setAudience({ kind: 'conversation', agentId: 'main', sessionKey: 'agent:main:group', sessionId: f.sessionId });
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

test('identity bindings persist across connections and competing registrations never replace them', async t => {
  const f = await fixture(t), rival = { ...f.manifest, publicationId: randomUUID() };
  const key = `store:${randomUUID()}`;
  const results = await Promise.all([f.store.registerIfAbsent(key, f.manifest), new SqliteIdentityStore(f.config.statePath).registerIfAbsent(key, rival)]);
  assert.deepEqual(results, [true, false]);
  assert.deepEqual(await new SqliteIdentityStore(f.config.statePath).lookup(key), f.manifest);
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
  assert.ok(entry.configSchema.jsonSchema.properties.stores.patternProperties);
  assert.equal(entry.configSchema.jsonSchema.properties.vault, undefined);
  assert.deepEqual(getToolPluginMetadata(entry).configSchema, entry.configSchema.jsonSchema);
  assert.equal(getToolPluginMetadata(entry).tools.length, Object.values(contract.operations).filter(operation => operation.tool).length);
});


test('all opt-in inspection views retain conversation scope and authority', async t => {
  const f = await fixture(t); f.setAudience({ kind: 'conversation', agentId: 'main', sessionKey: 'agent:main:group', sessionId: f.sessionId });
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
