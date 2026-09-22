import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readdir, readFile, writeFile, rename, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SampleVault, SAMPLE_ROOT, digest } from '../dist/vault.js';
import { contract } from '../dist/contract.js';
import { Check } from 'typebox/value';
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'knowledge-test-'));
  await cp(SAMPLE_ROOT, root, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, vault: new SampleVault(root) };
}
async function hashes(root) {
  const found = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) if (entry.isFile()) { const p = path.join(entry.parentPath, entry.name); found[path.relative(root, p)] = digest(await readFile(p, 'utf8')); }
  return found;
}
test('representative vault: records, schemas, diagnostics, citations, and zero writes', async () => {
  const before = await hashes(SAMPLE_ROOT), vault = new SampleVault(), data = await vault.scan();
  assert.equal(data.records.length, 11);
  assert.equal(data.records.filter(r => r.valid).length, 7);
  assert.equal(data.schemas.filter(s => s.valid).length, 8);
  assert.deepEqual(new Set(data.issues.map(i => i.code)), new Set(['invalid-schema','invalid-record','schema-unavailable','broken-reference','duplicate-id']));
  const result = await vault.detail('sample_claim_pilot');
  assert.equal(result.evidence[0].verified, true);
  assert.match(result.evidence[0].excerpt, /small pilot garden/);
  assert.ok(result.references.some(r => r.id === 'sample_person_alex'));
  assert.equal(Check(contract.operations.record.output, result), true);
  assert.deepEqual(await hashes(SAMPLE_ROOT), before);
});
test('bounded listing supports exhaustive pagination, aliases and kind filters', async () => {
  const vault = new SampleVault(); let offset = 0, rows = [];
  do { const result = await vault.list({offset, limit: 3}); assert.ok(Check(contract.operations.records.output, result)); rows.push(...result.records); offset = result.nextOffset; } while (offset !== null);
  assert.equal(rows.length, 11); assert.equal(new Set(rows.map(r => r.path)).size, 11);
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
  assert.equal((await vault.detail('sample_duplicate_id')).record, null);
  assert.equal((await vault.detail('missing-id')).record, null);
});
test('invalid edits deactivate schema and preserve source bytes', async t => {
  const {root, vault} = await fixture(t);
  const file = path.join(root,'schemas/project.yaml');
  await writeFile(file, 'format: [invalid\n'); const before = await hashes(root);
  const data = await vault.scan();
  assert.equal(data.schemas.find(s => s.path === 'schemas/project.yaml').valid, false);
  assert.ok(data.issues.some(i => i.path === 'projects/community-garden.md' && i.code === 'schema-unavailable'));
  assert.equal(data.schemas.find(s => s.path === 'schemas/leads.yaml').valid, false);
  assert.deepEqual(await hashes(root), before);
});
test('ambiguous schema definitions are all rejected', async t => {
  const {root,vault} = await fixture(t);
  await cp(path.join(root,'schemas/person.yaml'), path.join(root,'schemas/person-copy.yaml'));
  const data = await vault.scan();
  assert.equal(data.schemas.filter(s => s.definition?.name === 'person' && s.valid).length, 0);
  assert.ok(data.issues.some(i => i.code === 'duplicate-schema'));
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
test('scan byte limit refuses a partial catalog', async t => {
  const {root,vault} = await fixture(t);
  const original = await readFile(path.join(root,'people/alex-rivera.md'),'utf8');
  for (let i=0;i<135;i++) await writeFile(path.join(root,`notes/budget-${i}.md`),original.replace('sample_person_alex',`sample_budget_${i}`)+'x'.repeat(63000));
  await assert.rejects(vault.scan(), /scan budget/);
});
