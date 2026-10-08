import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describeSource, compactEvidence, expandEvidence, mapMetadataEvidence, sourceDescriptorPath } from '../dist/source-descriptors.js';

const origin = { path: 'artifacts/meeting/transcript.txt', sha256: 'a'.repeat(64), filename: 'transcript.txt', mediaType: 'text/plain', size: 100, attribution: 'Recorder original' };
const retained = describeSource(origin);
const read = path => { assert.equal(path, retained.path); return retained.raw; };

test('source identity is canonical, passage-independent and origin-sensitive', () => {
  const passage = { ...origin, start_line: 2, end_line: 3, quote: 'verbatim' };
  assert.deepEqual(describeSource(passage), retained);
  assert.equal(describeSource(Object.fromEntries(Object.entries(origin).reverse())).id, retained.id);
  for (const change of [{ attribution: 'Other origin' }, { path: 'artifacts/other.txt' }, { sha256: 'b'.repeat(64) }]) {
    assert.notEqual(describeSource({ ...origin, ...change }).id, retained.id);
  }
  assert.notEqual(describeSource({ ...origin, attribution: undefined }).id, describeSource({ ...origin, attribution: '' }).id);
});

test('hydrate and edit preserve origin independently of citation attribution', () => {
  const evidence = { ...origin, start_line: 2, end_line: 3, attribution: 'Speaker attribution' };
  const { citation } = compactEvidence(evidence, origin);
  assert.deepEqual(citation, { source: retained.id, start_line: 2, end_line: 3, attribution: 'Speaker attribution' });
  const expanded = expandEvidence(citation, read);
  assert.deepEqual(expanded, { ...evidence, source: retained.id });
  assert.deepEqual(compactEvidence(expanded, expandEvidence({ source: expanded.source }, read)).citation, citation);
  assert.deepEqual(expandEvidence(expanded, read), expanded);
  assert.throws(() => compactEvidence(expanded), /origin/);
  assert.throws(() => expandEvidence({ ...expanded, path: 'artifacts/forged.txt' }, read), /same retained source/);
  assert.throws(() => compactEvidence({ ...origin, attribution: undefined }, origin), /erase/);
  const empty = compactEvidence({ ...origin, attribution: '' }, origin);
  assert.equal(expandEvidence(empty.citation, read).attribution, '');
});

test('reject malformed ranges, IDs, corrupt or missing descriptors', () => {
  for (const range of [{ start_line: 1 }, { end_line: 1 }, { start_line: 2, end_line: 1 }, { start_line: 0, end_line: 1 }]) {
    assert.throws(() => compactEvidence({ ...origin, ...range }));
    assert.throws(() => expandEvidence({ source: retained.id, ...range }, read));
  }
  assert.throws(() => sourceDescriptorPath('../private/foo'));
  assert.throws(() => expandEvidence({ source: retained.id }, () => retained.raw + ' '));
  assert.throws(() => expandEvidence({ source: retained.id }, () => { throw Error('missing'); }), /missing/);
  const noncanonical = JSON.stringify(JSON.parse(retained.raw));
  const id = createHash('sha256').update(noncanonical).digest('hex');
  assert.throws(() => expandEvidence({ source: id }, () => noncanonical), /noncanonical/);
  assert.throws(() => expandEvidence({ source: retained.id, unexpected: true }, read));
  assert.deepEqual(expandEvidence(origin, () => { throw Error('legacy must not resolve'); }), origin);
});

test('only defined evidence locations are transformed, without mutation', () => {
  const basis = { basis: 'Supported', evidence: [origin] };
  const metadata = { evidence: [origin], attribution_confidence: { level: 'high', ...basis }, continuity: [{ id: 'some-page', relation: 'updates', ...basis }], identity: { status: 'partial', context: 'uncertain', candidates: [{ id: 'some-page', ...basis }] }, fields: { evidence: [origin] }, unknown: { evidence: [origin] } };
  const before = structuredClone(metadata); let visits = 0;
  const changed = mapMetadataEvidence(metadata, evidence => { visits++; return compactEvidence(evidence).citation; });
  assert.equal(visits, 4); assert.deepEqual(metadata, before);
  assert.equal(changed.fields, metadata.fields); assert.equal(changed.unknown, metadata.unknown);
  const restored = mapMetadataEvidence(changed, value => { const { source, ...evidence } = expandEvidence(value, read); return evidence; });
  assert.deepEqual(restored, metadata);
});
