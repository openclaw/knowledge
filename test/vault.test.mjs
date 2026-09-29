import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readdir, readFile, writeFile, rename, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SampleVault, SAMPLE_ROOT, digest } from '../dist/vault.js';
import { inspectRecord, inspectOntology } from "../dist/inspection.js";
import { contract } from '../dist/contract.js';
import { Check } from 'typebox/value';
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'knowledge-test-'));
  await cp(SAMPLE_ROOT, root, { recursive: true });
  await mkdir(path.join(root, "notes"), { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, vault: new SampleVault(root) };
}
async function hashes(root) {
  const found = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) if (entry.isFile()) { const p = path.join(entry.parentPath, entry.name); found[path.relative(root, p)] = digest(await readFile(p, 'utf8')); }
  return found;
}
test('representative vault: records, ontology, diagnostics, citations, and zero writes', async () => {
  const before = await hashes(SAMPLE_ROOT), vault = new SampleVault(), data = await vault.scan();
  assert.equal(data.records.length, 7);
  assert.equal(data.records.filter(r => r.valid).length, 7);
  assert.equal(data.ontology.definitions.length, 38);
  assert.equal(Check(contract.operations.ontology.output, await inspectOntology(vault, {})), true);
  assert.deepEqual(data.issues, []);
  const result = await vault.detail('sample_claim_pilot');
  assert.equal(result.evidence[0].verified, true);
  assert.match(result.evidence[0].excerpt, /small pilot garden/);
  assert.ok(result.references.some(r => r.id === 'sample_person_alex'));
  assert.equal(Check(contract.operations.record.output, await inspectRecord(vault, {id: "sample_claim_pilot"})), true);
  assert.deepEqual(await hashes(SAMPLE_ROOT), before);
});
test('bounded listing supports exhaustive pagination, aliases and kind filters', async () => {
  const vault = new SampleVault(); let offset = 0, rows = [];
  do { const result = await vault.list({offset, limit: 3}); assert.ok(Check(contract.operations.records.output, result)); rows.push(...result.records); offset = result.nextOffset; } while (offset !== null);
  assert.equal(rows.length, 7); assert.equal(new Set(rows.map(r => r.path)).size, 7);
  assert.ok((await vault.list({query:'Garden pilot'})).records.some(r => r.id === 'sample_project_garden'));
  assert.equal((await vault.list({kind:'claim'})).total, 1);
  assert.equal((await vault.list({query:'not here'})).total, 0);
  assert.equal(Check(contract.operations.records.input, {limit: 101}), false);
  assert.equal(Check(contract.operations.records.input, {root:'/etc'}), false);
});
test('rename preserves identity and metadata; duplicate IDs never pick a winner', async t => {
  const { root, vault } = await fixture(t);
  const before = await vault.detail('sample_person_alex');
  await rename(path.join(root,'people/alex-rivera.md'), path.join(root,'people/renamed.md'));
  const after = await vault.detail('sample_person_alex');
  assert.equal(after.record.hash, before.record.hash); assert.equal(after.record.path, 'people/renamed.md');
  assert.equal(JSON.parse(after.record.metadata).custom_note, 'Unknown user metadata is preserved.');
  await cp(new URL('./fixtures/invalid-vault/', import.meta.url), root, { recursive: true });
  assert.equal((await vault.detail('sample_duplicate_id')).record, null);
  assert.equal((await vault.detail('missing-id')).record, null);
});
test('invalid record fixtures stay separate from the visible sample and remain byte-preserved', async t => {
  const {root, vault} = await fixture(t);
  await cp(new URL('./fixtures/invalid-vault/', import.meta.url), root, {recursive:true});
  const before = await hashes(root), data = await vault.scan();
  assert.deepEqual(new Set(data.issues.map(i=>i.code)), new Set(['invalid-record','ontology-unavailable','broken-reference','duplicate-id']));
  assert.equal(data.records.length,11);
  assert.deepEqual(await hashes(root),before);
});
test('changed source invalidates evidence without serving unverified content', async t => {
  const {root,vault} = await fixture(t);
  await writeFile(path.join(root,'artifacts/planning-meeting.txt'),'Changed source\n');
  const result = await vault.detail('sample_claim_pilot');
  assert.equal(result.record.valid, false); assert.equal(result.evidence[0].verified,false); assert.equal(result.evidence[0].excerpt,'');
  assert.ok(result.issues.some(i=>i.code==='invalid-evidence'));
});
test('file symlinks and path traversal are not followed', async t => {
  const {root,vault} = await fixture(t);
  await symlink('/etc/passwd', path.join(root,'notes/secret.md'));
  const file = path.join(root,'claims/pilot-decision.md');
  await writeFile(file,(await readFile(file,'utf8')).replace('artifacts/planning-meeting.txt','artifacts/../../private.txt'));
  const data = await vault.scan();
  assert.ok(data.issues.some(i=>i.code==='unsafe-path'));
  assert.ok(data.issues.some(i=>i.code==='invalid-evidence'));
  assert.equal(data.records.some(r=>r.path==='notes/secret.md'),false);
});
test('duplicate keys, unknown scope, YAML alias expansion and oversize records are diagnosed', async t => {
  const {root,vault} = await fixture(t);
  const original = await readFile(path.join(root,'people/alex-rivera.md'),'utf8');
  await writeFile(path.join(root,'notes/duplicate-key.md'),original.replace('revision: 1','revision: 1\nrevision: 2'));
  await writeFile(path.join(root,'notes/unknown-scope.md'),original.replace('visibility: sample','visibility: agent-private'));
  await writeFile(path.join(root,'notes/alias.md'),original.replace('custom_note: Unknown user metadata is preserved.','custom_note: &x [1, 2]\nextra: *x'));
  await writeFile(path.join(root,'notes/large.md'),'x'.repeat(65537));
  const data = await vault.scan();
  for (const file of ['duplicate-key','unknown-scope','alias','large']) assert.ok(data.issues.some(i=>i.path===`notes/${file}.md` && i.code==='invalid-record'),file);
});
test('total partition size does not cap a scan; every record is cataloged', async t => {
  const {root,vault} = await fixture(t);
  const original = await readFile(path.join(root,'people/alex-rivera.md'),'utf8');
  const before = (await vault.scan()).records.length;
  // ~8.5 MB: past the retired 8 MiB whole-scan budget; each file stays under 64 KiB.
  for (let i=0;i<135;i++) await writeFile(path.join(root,`notes/budget-${i}.md`),original.replace('sample_person_alex',`sample_budget_${i}`)+'x'.repeat(63000));
  const data = await vault.scan();
  assert.equal(data.records.length, before + 135);
  assert.equal(data.records.filter(r => r.path.startsWith('notes/budget-') && !r.valid).length, 0);
});
