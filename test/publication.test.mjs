import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Check } from 'typebox/value';
import { Publisher } from '../dist/publisher.js';
import { SqliteIdentityStore } from '../dist/identity-store.js';
import { createKnowledgeService } from '../dist/service.js';
import { authorizeVault } from '../dist/access.js';
import { contract } from '../dist/contract.js';

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'knowledge-write-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'vault'); await mkdir(root); await mkdir(path.join(root, 'private'));
  const manifest = { format: 'knowledge-vault-v1', vaultId: randomUUID(), agentId: 'main', generation: 0, publicationId: randomUUID() };
  await writeFile(path.join(root, 'vault.json'), JSON.stringify(manifest));
  const config = { root, statePath: path.join(base, 'state.sqlite'), agentId: 'main', vaultId: manifest.vaultId, publicationId: manifest.publicationId, operatorRead: true, writesEnabled: true };
  const api = { pluginConfig: { vault: config } };
  const owner = { source: 'tool', api, tool: { agentId: 'main', memoryAudience: { kind: 'owner-private', agentId: 'main' }, assertInvocationCurrent() {}, assertMemoryAudienceCurrent() {} } };
  const operator = { source: 'session-action', api, action: { client: { connId: 'test', scopes: ['operator.write'] } } };
  const store = new SqliteIdentityStore(config.statePath), service = createKnowledgeService(api);
  const access = () => authorizeVault(owner, 'main', true, true);
  return { base, root, config, manifest, api, owner, operator, store, service, access,
    setAudience: value => { owner.tool.memoryAudience = value; } };
}
const draft = () => ({ requestId: randomUUID(), title: 'Publication test', type: 'note', body: 'Authored text.\n' });
const edit = (record, fields = {}) => ({ requestId: randomUUID(), id: record.id, expectedRevision: record.revision, expectedHash: record.hash, title: record.title, body: record.body, ...fields });

test('UI creates sourced page; agent reads and edits; durable retry/history/readback agree', async t => {
  const f = await fixture(t), input = { ...draft(), source: { text: 'Exact original\nSecond line', attribution: 'User supplied note' } };
  const receipt = await f.service.save_page(input, f.operator);
  assert.equal(receipt.state, 'published'); assert.ok(Check(contract.operations.save_page.output, receipt));
  const read = await f.service.record({ id: receipt.id }, f.owner);
  assert.equal(read.record.body, input.body); assert.equal(read.evidence[0].verified, true);
  const changed = await f.service.save_page(edit(read.record, { body: 'Agent revision\n' }), f.owner);
  assert.equal(changed.revision, 2); assert.equal((await f.service.record({ id: receipt.id }, f.operator)).record.body, 'Agent revision\n');
  assert.deepEqual(await createKnowledgeService(f.api).save_page(input, f.operator), receipt);
  await assert.rejects(f.service.save_page({ ...input, body: 'changed payload' }, f.operator), /different payload/);
  const history = await f.service.history({}, f.owner);
  assert.ok(Check(contract.operations.history.output, history)); assert.equal(history.mutations.length, 2);
  assert.deepEqual(history.entries.map(e => e.provenance), ['agent', 'operator']);
  assert.equal(JSON.parse(await readFile(path.join(f.root, 'vault.json'), 'utf8')).generation, 2);
});

test('stale hash/revision, rename, deletion, and unknown metadata preservation', async t => {
  const f = await fixture(t), created = await f.service.save_page(draft(), f.owner);
  const original = (await f.service.record({ id: created.id }, f.owner)).record;
  const full = path.join(f.root, 'private', created.path);
  await writeFile(full, (await f.service.record({ id: created.id, view: 'raw' }, f.owner)).record.raw.replace('title:', 'custom: preserve-me\n# authored comment\ntitle:').replace('Authored text.', 'External prose.'));
  const rejected = edit(original);
  await assert.rejects(f.service.save_page(rejected, f.owner), /this draft was not saved/);
  assert.deepEqual(await f.service.mutation({requestId: rejected.requestId}, f.owner), {receipt:null,files:[]});
  let current = (await f.service.record({ id: created.id }, f.owner)).record;
  assert.equal(current.revision, 2);
  await rename(full, full + '-renamed.md');
  current = (await f.service.record({ id: created.id }, f.owner)).record;
  assert.equal(current.revision, 3);
  const saved = await f.service.save_page(edit(current, { title: 'New title' }), f.owner);
  const updated = (await f.service.record({ id: created.id }, f.owner)).record;
  const updatedRaw = (await f.service.record({id: created.id, view: 'raw'}, f.owner)).record.raw;
  assert.match(updatedRaw, /custom: preserve-me/); assert.match(updatedRaw, /# authored comment/); assert.equal(updated.body, 'External prose.\n'); assert.equal(saved.revision, 4);
  await rm(full + '-renamed.md'); await assert.rejects(f.service.save_page(edit(updated), f.owner), /conflict/);
  assert.equal((await f.service.record({ id: created.id }, f.owner)).record, null);
  assert.equal((await f.service.history({}, f.owner)).entries[0].provenance, 'external-unavailable');
});

for (const stage of ['after-accept', 'after-install:private/artifacts/', 'after-link:private/artifacts/', 'after-link:vault.json', 'after-displace:vault.json', 'after-install:vault.json', 'before-receipt']) test(`interruption at ${stage} recovers once across restart`, async t => {
  const f = await fixture(t), input = { ...draft(), source: { text: 'Retained evidence', attribution: 'Test original' } };
  const publisher = new Publisher(f.config, f.store, where => { if (where.startsWith(stage)) throw Error('simulated crash'); });
  await assert.rejects(publisher.save(input, f.access(), 'agent'), /simulated crash/);
  await assert.rejects(f.service.records({}, f.owner), /publication|identity/);
  const resumed = await createKnowledgeService(f.api).save_page(input, f.owner);
  assert.equal(resumed.state, 'published'); assert.equal((await f.service.records({}, f.owner)).total, 1);
  assert.equal((await f.service.history({}, f.owner)).mutations.length, 1);
  assert.deepEqual(await f.service.save_page(input, f.owner), resumed);
});

test('external rewrite immediately before displacement retains editor and intended versions', async t => {
  const f = await fixture(t), created = await f.service.save_page(draft(), f.owner);
  const r = (await f.service.record({ id: created.id }, f.owner)).record, input = edit(r, { body: 'Plugin proposal\n' });
  const originalRaw = (await f.service.record({id: created.id, view: 'raw'}, f.owner)).record.raw;
  const publisher = new Publisher(f.config, f.store, where => { if (where === `before-displace:private/${r.path}`) writeFileSync(path.join(f.root, 'private', r.path), originalRaw.replace('Authored text.', 'Racing editor.')); });
  const receipt = await publisher.save(input, f.access(), 'agent');
  assert.equal(receipt.state, 'conflict');
  const retained = await readFile(path.join(f.root, 'private', '.knowledge-history', input.requestId, '0.before'), 'utf8');
  assert.match(retained, /Racing editor/);
  assert.match(await readFile(path.join(f.root, 'private', r.path), 'utf8'), /Racing editor/);
  const row = f.store.withDatabase(db => db.prepare('SELECT plan FROM mutations WHERE request=?').get(input.requestId));
  assert.match(row.plan, /Plugin proposal/);
  await assert.rejects(f.service.records({}, f.owner), /publication/);
  assert.equal((await f.service.history({}, f.owner)).mutations[0].state, 'conflict');
  const detail = await f.service.mutation({ requestId: input.requestId }, f.owner);
  assert.match(detail.files[0].displaced, /Racing editor/); assert.match(detail.files[0].proposed, /Plugin proposal/);
});

test('new editor file between displacement and installation is never overwritten', async t => {
  const f = await fixture(t), created = await f.service.save_page(draft(), f.owner);
  const r = (await f.service.record({ id: created.id }, f.owner)).record;
  const publisher = new Publisher(f.config, f.store, where => { if (where === `before-install:private/${r.path}`) writeFileSync(path.join(f.root, 'private', r.path), 'New editor file'); });
  const receipt = await publisher.save(edit(r, { body: 'Plugin proposal' }), f.access(), 'agent');
  assert.equal(receipt.state, 'conflict'); assert.equal(await readFile(path.join(f.root, 'private', r.path), 'utf8'), 'New editor file');
});

test('write authority, scope isolation, missing conversation creation and disabled/sample writes', async t => {
  const f = await fixture(t);
  const readOnly = { ...f.operator, action: { client: { connId: 'x', scopes: ['operator.read'] } } };
  await assert.rejects(f.service.save_page(draft(), readOnly), /authority/);
  const input = draft(), privateReceipt = await f.service.save_page(input, f.owner);
  f.setAudience({ kind: 'conversation', agentId: 'main', sessionKey: 'agent:main:group', sessionId: randomUUID() });
  assert.equal((await f.service.history({}, f.owner)).mutations.length, 0);
  await assert.rejects(f.service.resume({ requestId: input.requestId }, f.owner), /unavailable/);
  const shared = await f.service.save_page(input, f.owner);
  assert.notEqual(shared.id, privateReceipt.id);
  assert.equal((await f.service.record({ id: privateReceipt.id }, f.owner)).record, null);
  assert.equal((await f.service.record({ id: shared.id }, f.operator)).record, null);
  await assert.rejects(createKnowledgeService({ ...f.api, pluginConfig: {} }).save_page(draft(), f.owner), /read-only/);
});

async function childWrite(f, input, crashAt) {
  const { spawn } = await import('node:child_process');
  const source = `
    import { Publisher } from './dist/publisher.js';
    import { SqliteIdentityStore } from './dist/identity-store.js';
    let data=''; for await (const c of process.stdin) data+=c;
    const { config, input, crashAt } = JSON.parse(data);
    const publisher = new Publisher(config,new SqliteIdentityStore(config.statePath), stage => { if(stage === crashAt) process.exit(77); });
    try { console.log(JSON.stringify(await publisher.save(input,{scope:{visibility:'agent-private',agentId:'main'},assertCurrent(){}},'agent'))); }
    catch(e) { console.error(e.message); process.exitCode=1; }
  `;
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', source], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify({ config: f.config, input, crashAt }));
  });
}

test('actual process death with a live SQLite transaction and two stage hardlinks recovers', async t => {
  const f = await fixture(t), input = draft();
  await f.service.status({}, f.owner);
  const killed = await childWrite(f, input, 'after-link:vault.json'); assert.equal(killed.code, 77);
  const receipt = await f.service.save_page(input, f.owner);
  assert.equal(receipt.state, 'published'); assert.equal((await f.service.records({}, f.owner)).total, 1);
});

test('cross-process publishers fence competing edits and never lose the winner', async t => {
  const f = await fixture(t), created = await f.service.save_page(draft(), f.owner);
  const r = (await f.service.record({ id: created.id }, f.owner)).record;
  const inputs = [edit(r, { body: 'Writer one' }), edit(r, { body: 'Writer two' })];
  const results = await Promise.all(inputs.map(input => childWrite(f, input)));
  assert.equal(results.filter(r => r.code === 0).length, 1, JSON.stringify(results));
  const winner = JSON.parse(results.find(r => r.code === 0).stdout);
  assert.equal(winner.state, 'published');
  const current = (await f.service.record({ id: created.id }, f.owner)).record;
  assert.equal(current.hash, winner.hash); assert.equal(current.revision, 2);
});

test('revision snapshots and publication details never cross conversation boundaries', async t => {
  const f = await fixture(t), input = draft(); await f.service.save_page(input, f.owner);
  const sequence = (await f.service.history({}, f.owner)).entries[0].sequence;
  assert.match((await f.service.revision({ sequence }, f.owner)).raw, /Authored text/);
  f.setAudience({ kind: 'conversation', agentId: 'main', sessionKey: 'agent:main:group', sessionId: randomUUID() });
  assert.equal((await f.service.revision({ sequence }, f.owner)).raw, null);
  assert.equal((await f.service.mutation({ requestId: input.requestId }, f.owner)).receipt, null);
});

test('authority expires after acceptance: no new files; original scope can resume', async t => {
  const f = await fixture(t), input = draft(); let current = true;
  const access = { scope: { visibility: 'agent-private', agentId: 'main' }, assertCurrent() { if (!current) throw Error('revoked'); } };
  const publisher = new Publisher(f.config, f.store, where => { if (where === 'after-accept') current = false; });
  await assert.rejects(publisher.save(input, access, 'agent'), /revoked/);
  assert.equal((await f.service.history({}, f.operator)).mutations[0].state, 'accepted');
  assert.equal((await f.service.save_page(input, f.owner)).state, 'published');
});

test('published generation restore and pending replacement roots are fenced', async t => {
  const f = await fixture(t); await f.service.save_page(draft(), f.owner);
  await writeFile(path.join(f.root, 'vault.json'), JSON.stringify(f.manifest));
  await assert.rejects(f.service.history({}, f.owner), /identity/);
  await assert.rejects(f.service.records({}, f.owner), /identity/);
});
