import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Check } from 'typebox/value';
import { SampleVault, SAMPLE_ROOT } from '../dist/vault.js';
import { inspectRecord, inspectOntology, RECORD_RESPONSE_BYTES } from '../dist/inspection.js';
import { contract } from '../dist/contract.js';
import { loadVocabulary } from '../dist/inspection-client.js';

const checked = (operation, result) => { assert.ok(Check(contract.operations[operation].output, result), JSON.stringify(result).slice(0, 300)); return result; };
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'knowledge-inspection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(SAMPLE_ROOT, root, { recursive: true });
  return { root, vault: new SampleVault(root) };
}

test('record defaults return content once and compact metadata without evidence', async () => {
  const vault = new SampleVault(), result = checked('record', await inspectRecord(vault, { id: 'sample_claim_pilot' }));
  assert.ok(result.record.body); assert.equal(result.record.raw, undefined); assert.ok(result.record.metadata); assert.equal(result.record.metadata.evidence, undefined);
  assert.equal(result.references, undefined); assert.ok(result.record.attribution); assert.ok(result.record.assertionOrigin);
  assert.equal(result.evidence, undefined); assert.equal(result.content.nextOffset, null);
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
  assert.equal(raw.record.raw, original.record.raw.slice(0, raw.record.raw.length)); assert.ok(raw.content.nextOffset); assert.equal(raw.record.body, undefined); assert.equal(raw.evidence, undefined);
  const summary = checked('record', await inspectRecord(vault, { id: 'sample_person_alex', view: 'summary', includeMetadata: true }));
  assert.equal(summary.record.body, undefined); assert.equal(summary.record.metadata.custom_note, 'Unknown user metadata is preserved.');
  const beyond = checked('record', await inspectRecord(vault, { id: 'sample_person_alex', offset: 999999 }));
  assert.equal(beyond.record.body, ''); assert.equal(beyond.content.nextOffset, null);
});

test('evidence budgets disclose truncation; references are paginated separately', async () => {
  const vault = new SampleVault();
  const small = checked('record', await inspectRecord(vault, { id: 'sample_claim_pilot', includeEvidence: true, maxEvidenceChars: 8, includeReferences: true, referenceLimit: 1 }));
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


test('every ontology definition is JSON-safe before host serialization, including relationships without behaviors', async () => {
  const vault = new SampleVault();
  let offset = 0, total = 0;
  do {
    const result = checked('ontology', await inspectOntology(vault, { view: 'definitions', includeRecords: true, limit: 10, offset }));
    assert.deepEqual(result, JSON.parse(JSON.stringify(result)), 'Undefined properties are rejected by the feature transport');
    total += result.definitions.length; offset = result.nextOffset;
  } while (offset !== null);
  assert.equal(total, 38);
});


test('record byte limit traverses escaped Unicode text losslessly', async t => {
  const { root, vault } = await fixture(t), file = path.join(root, 'people/alex-rivera.md');
  await writeFile(file, (await readFile(file, 'utf8')) + '\n' + '🦞\"\\\n'.repeat(9000));
  const original = (await vault.detail('sample_person_alex')).record.raw;
  let offset = 0, raw = '';
  do {
    const page = checked('record', await inspectRecord(vault, { id: 'sample_person_alex', view: 'raw', metadataView: 'none', maxChars: 65536, offset }));
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= RECORD_RESPONSE_BYTES);
    raw += page.record.raw;
    assert.ok(page.content.nextOffset === null || page.content.nextOffset > offset);
    offset = page.content.nextOffset;
  } while (offset !== null);
  assert.equal(raw, original);
});

test('compact metadata preserves uncertainty without nested evidence; explicit selectors and oversized full metadata', async () => {
  const vault = new SampleVault(), detail = await vault.detail('sample_claim_pilot');
  const metadata = JSON.parse(detail.record.metadata);
  metadata.attribution_confidence = { level: 'low', basis: 'Unclear speaker', evidence: [{path:'secret-evidence',sha256:'a'.repeat(64)}] };
  metadata.identity = { status: 'partial', context: 'Handle only', candidates: [{id:'candidate_id',basis:'Unresolved match',evidence:metadata.attribution_confidence.evidence}] };
  metadata.fields = { huge: 'x'.repeat(40000) };
  detail.record.metadata = JSON.stringify(metadata);
  detail.record.attributionConfidence = metadata.attribution_confidence;
  const fake = { detail: async () => structuredClone(detail) };
  const result = checked('record', await inspectRecord(fake, {id:detail.record.id}));
  assert.equal(result.record.metadata.attribution_confidence.level, 'low');
  assert.equal(result.record.metadata.identity.candidates[0].basis, 'Unresolved match');
  assert.ok(!JSON.stringify(result).includes('secret-evidence'));
  assert.equal(result.record.metadata.fields, undefined);
  await assert.rejects(inspectRecord(fake, {id:detail.record.id, metadataView:'compact', includeMetadata:false}), /not both/);
  await assert.rejects(inspectRecord(fake, {id:detail.record.id, view:'summary', metadataView:'full'}), /exceeds response budget/);
  const explicit = checked('record', await inspectRecord(vault, {id:'sample_claim_pilot', includeEvidence:true}));
  assert.equal(explicit.evidence[0].verified, true);
});


test('byte-bounded evidence pages preserve every locator and make progress', async () => {
  const vault = new SampleVault(), detail = await vault.detail('sample_claim_pilot');
  const evidence = Array.from({length:30}, (_, i) => ({...detail.evidence[0], path:'evidence-'+i, attribution:'x'.repeat(1000), quote:'🦞'.repeat(1500)}));
  const fake = { detail: async (_, start, limit) => ({ ...structuredClone(detail), evidence: evidence.slice(start, start+limit), evidenceTotal:evidence.length, sourceFiles:[], identityEvidence:[], relatedStatements:[] }) };
  let offset=0, paths=[];
  do {
    const result = checked('record', await inspectRecord(fake, {id:detail.record.id, view:'summary', includeEvidence:true, evidenceOffset:offset}));
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= RECORD_RESPONSE_BYTES);
    paths.push(...result.evidence.map(e=>e.path));
    assert.ok(result.nextEvidenceOffset===null || result.nextEvidenceOffset>offset);
    offset=result.nextEvidenceOffset;
  } while(offset!==null);
  assert.deepEqual(paths,evidence.map(e=>e.path));
});
