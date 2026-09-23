import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Check } from 'typebox/value';
import { SampleVault, SAMPLE_ROOT } from '../dist/vault.js';
import { inspectRecord, inspectOntology } from '../dist/inspection.js';
import { contract } from '../dist/contract.js';
import { loadVocabulary } from '../dist/inspection-client.js';

const checked = (operation, result) => { assert.ok(Check(contract.operations[operation].output, result), JSON.stringify(result).slice(0, 300)); return result; };
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'knowledge-inspection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(SAMPLE_ROOT, root, { recursive: true });
  return { root, vault: new SampleVault(root) };
}

test('record defaults return content once, provenance and evidence, without raw or full metadata', async () => {
  const vault = new SampleVault(), result = checked('record', await inspectRecord(vault, { id: 'sample_claim_pilot' }));
  assert.ok(result.record.body); assert.equal(result.record.raw, undefined); assert.equal(result.record.metadata, undefined);
  assert.equal(result.references, undefined); assert.ok(result.record.attribution); assert.ok(result.record.assertionOrigin);
  assert.equal(result.evidence[0].verified, true); assert.equal(result.content.nextOffset, null);
  for (const id of ['missing-id', 'sample_duplicate_id']) assert.equal(checked('record', await inspectRecord(vault, { id })).record, null);
});

test('record text pages reassemble the exact observed body; raw is an alternative representation', async t => {
  const { root, vault } = await fixture(t), file = path.join(root, 'people/alex-rivera.md');
  await writeFile(file, (await readFile(file, 'utf8')) + '\n' + 'A long paragraph. '.repeat(1800));
  const original = await vault.detail('sample_person_alex'); let offset = 0, body = '', hash;
  do {
    const r = checked('record', await inspectRecord(vault, { id: 'sample_person_alex', maxChars: 1000, offset }));
    body += r.record.body; assert.ok(r.record.body.length <= 1000);
    hash ??= r.record.hash; assert.equal(r.record.hash, hash); offset = r.content.nextOffset;
  } while (offset !== null);
  assert.equal(body, original.record.body);
  const raw = checked('record', await inspectRecord(vault, { id: 'sample_person_alex', view: 'raw', maxChars: 65536 }));
  assert.equal(raw.record.raw, original.record.raw); assert.equal(raw.record.body, undefined); assert.equal(raw.evidence, undefined);
  const summary = checked('record', await inspectRecord(vault, { id: 'sample_person_alex', view: 'summary', includeMetadata: true }));
  assert.equal(summary.record.body, undefined); assert.equal(summary.record.metadata.custom_note, 'Unknown user metadata is preserved.');
  const beyond = checked('record', await inspectRecord(vault, { id: 'sample_person_alex', offset: 999999 }));
  assert.equal(beyond.record.body, ''); assert.equal(beyond.content.nextOffset, null);
});

test('evidence budgets disclose truncation; references are paginated separately', async () => {
  const vault = new SampleVault();
  const small = checked('record', await inspectRecord(vault, { id: 'sample_claim_pilot', maxEvidenceChars: 8, includeReferences: true, referenceLimit: 1 }));
  assert.equal(small.evidence[0].excerpt.length, 8); assert.equal(small.evidence[0].excerptTruncated, true);
  assert.equal(small.evidence[0].verified, true); assert.equal(small.references.length, 1);
  const refs = [...small.references]; let offset = small.nextReferenceOffset;
  while (offset !== null) {
    const r = checked('record', await inspectRecord(vault, { id: 'sample_claim_pilot', view: 'summary', includeReferences: true, referenceLimit: 1, referenceOffset: offset }));
    refs.push(...r.references); offset = r.nextReferenceOffset;
  }
  assert.equal(refs.length, small.referenceTotal); assert.equal(new Set(refs.map(r => r.path)).size, refs.length);
});

test('ontology catalog is concise; definition detail is structured and filtered', async () => {
  const vault = new SampleVault(), result = checked('ontology', await inspectOntology(vault, {}));
  assert.equal(result.total, 38); assert.equal(result.definitions.length, 38);
  assert.equal(result.sources, undefined); assert.equal(result.issues, undefined);
  for (const d of result.definitions) { assert.equal(d.fields, undefined); assert.equal(d.effective, undefined); assert.equal(d.records, undefined); }
  const detail = checked('ontology', await inspectOntology(vault, { view: 'definitions', name: 'project', includeRecords: true }));
  assert.equal(detail.total, 1); assert.ok(detail.definitions[0].fields.some(f => f.name === 'status'));
  assert.ok(detail.definitions[0].source); assert.equal(typeof detail.definitions[0].behaviors, 'object');
  assert.ok(detail.definitions[0].records.length); assert.equal(detail.definitions[0].effective, undefined);
  assert.ok(JSON.stringify(result).length < JSON.stringify(await vault.inspectOntology()).length / 2);
  assert.equal(checked('ontology', await inspectOntology(vault, { name: 'missing' })).total, 0);
});

test('ontology pages are exhaustive and the UI follows all pages', async () => {
  const vault = new SampleVault(); let offset = 0, names = [];
  do {
    const page = checked('ontology', await inspectOntology(vault, { kind: 'page', offset, limit: 3 }));
    names.push(...page.definitions.map(d => d.name)); offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(names.length, 19); assert.equal(new Set(names).size, 19);
  // Force a small page size to exercise the real UI continuation helper.
  const feature = { invoke: async (_, input) => inspectOntology(vault, { ...input, limit: 3 }) };
  assert.equal((await loadVocabulary(feature)).definitions.length, 19);
  assert.equal((await loadVocabulary(feature, true)).definitions.length, 38);
  let calls = 0;
  await assert.rejects(loadVocabulary({ invoke: async (_, input) => ({ ...await inspectOntology(vault, { ...input, limit: 3 }), fingerprint: String(calls++) }) }), /changed while loading/);
});

test('source view is opt-in, bounded, and refuses arbitrary paths; invalid YAML remains diagnosable', async t => {
  const { root, vault } = await fixture(t), broken = 'format: [broken\n' + '# comment\n'.repeat(80);
  await writeFile(path.join(root, 'ontology.yaml'), broken);
  const catalog = checked('ontology', await inspectOntology(vault, {}));
  assert.equal(catalog.available, false); assert.equal(catalog.definitions.length, 0); assert.ok(catalog.totalIssues > 0);
  const sources = checked('ontology', await inspectOntology(vault, { view: 'sources' }));
  assert.ok(sources.sources.some(s => s.path === 'ontology.yaml' && !s.valid)); assert.equal(sources.source, undefined);
  let raw = '', offset = 0;
  do {
    const page = checked('ontology', await inspectOntology(vault, { view: 'sources', sourcePath: 'ontology.yaml', maxChars: 256, offset }));
    raw += page.source.raw; offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(raw, broken);
  const diagnostics = checked('ontology', await inspectOntology(vault, { view: 'diagnostics', limit: 1 }));
  assert.equal(diagnostics.issues.length, 1); assert.ok(diagnostics.nextOffset);
  await assert.rejects(inspectOntology(vault, { view: 'sources', sourcePath: '../../etc/passwd' }), /unavailable/);
  await assert.rejects(inspectOntology(vault, { sourcePath: 'ontology.yaml' }), /requires view=sources/);
});

test('inspection inputs reject invalid budgets and authority selectors', () => {
  for (const input of [{id:'sample_person_alex',maxChars:0},{id:'sample_person_alex',referenceLimit:101},{id:'sample_person_alex',root:'/etc'}]) assert.equal(Check(contract.operations.record.input,input),false);
  for (const input of [{view:'all'},{limit:0},{offset:-1},{agent:'other'}]) assert.equal(Check(contract.operations.ontology.input,input),false);
});
