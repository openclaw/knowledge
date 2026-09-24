import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Check } from 'typebox/value';
import { SampleVault } from '../dist/vault.js';
import { connections } from '../dist/connections.js';
import { contract } from '../dist/contract.js';

const checked = (op, result) => {
  assert.ok(Check(contract.operations[op].output, result));
  assert.deepEqual(result, JSON.parse(JSON.stringify(result)), 'Card responses must be JSON-safe before host serialization');
  return result;
};

test('claim cards use one scan per page, preserve pagination and omit evidence/full metadata', async () => {
  const vault = new SampleVault(), data = await vault.scan();
  const claim = data.records.find(r => r.id === 'sample_claim_pilot');
  const records = Array.from({length: 55}, (_, i) => ({...claim, id: i === 0 ? claim.id : `sample_claim_${i}`, body: 'x'.repeat(5000), metadata: {...claim.metadata, id: i === 0 ? claim.id : `sample_claim_${i}`, custom_note: 'Not card data'}}));
  data.records = [...data.records.filter(r => r.kind !== 'claim'), ...records];
  let scans = 0;
  vault.scan = async () => { scans++; return data; };
  vault.detail = () => { throw Error('Card lists must not call detail'); };
  const first = checked('records', await vault.list({kind:'claim', includeCards:true, limit:50}));
  assert.equal(scans, 1); assert.equal(first.records.length, 50); assert.equal(first.total, 55); assert.equal(first.nextOffset, 50);
  for (const row of first.records) {
    assert.equal(row.card.body.length, 4000); assert.equal(row.card.truncated, true);
    assert.equal(row.card.hash, claim.hash); assert.equal(row.card.evidenceTotal, claim.metadata.evidence.length);
    assert.equal(row.card.assertionOrigin, claim.metadata.assertion_origin);
    assert.equal(row.card.evidence, undefined); assert.equal(row.card.metadata.evidence, undefined); assert.equal(row.card.metadata.custom_note, undefined);
  }
  const last = checked('records', await vault.list({kind:'claim', includeCards:true, offset:first.nextOffset, limit:50}));
  assert.equal(scans, 2); assert.equal(last.records.length, 5); assert.equal(last.nextOffset, null);
  assert.equal(new Set([...first.records, ...last.records].map(r => r.id)).size, 55);
  const concise = checked('records', await vault.list({kind:'claim'}));
  assert.ok(concise.records.every(r => !r.card));
});

test('card projection preserves eligibility, filtering and entity/owner grouping data', async () => {
  const vault = new SampleVault();
  const normal = await vault.list({kind:'claim'});
  const cards = checked('records', await vault.list({kind:'claim', includeCards:true}));
  assert.deepEqual(cards.records.map(({card, ...r}) => r), normal.records);
  assert.ok(cards.records.every(r => r.valid && r.lifecycle === 'active'));
  const data = await vault.scan();
  const claim = data.records.find(r => r.id === 'sample_claim_pilot');
  for (const target of claim.metadata.entities) {
    const input = {id:target, direction:'claims'};
    const plain = checked('connections', connections(data, input));
    const enriched = checked('connections', connections(data, {...input, includeCards:true}));
    assert.equal(enriched.snapshot, plain.snapshot); assert.equal(enriched.total, plain.total);
    assert.ok(enriched.connections.every(r => r.record.card));
    const linked = enriched.connections.find(r => r.record.id === claim.id).record.card;
    assert.deepEqual(linked.metadata.entities, claim.metadata.entities);
    assert.equal(linked.metadata.owner, claim.metadata.owner); assert.equal(linked.metadata.due_at, claim.metadata.due_at);
  }
  const filtered = checked('records', await vault.list({kind:'claim', query:claim.id, includeCards:true}));
  assert.deepEqual(filtered.records.map(r => r.id), [claim.id]);
  assert.equal(checked('records', await vault.list({kind:'page', includeCards:true})).records.some(r => r.card), false);
});
