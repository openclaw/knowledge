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

test('relationship browse batches deduplicated eligible endpoints in one scan per page', async () => {
  const vault = new SampleVault(), data = await vault.scan();
  const edge = data.records.find(r => r.kind === 'relationship');
  assert.ok(edge);
  const edges = Array.from({length:55}, (_, i) => ({...edge, id:`edge_${i}`, metadata:{...edge.metadata,id:`edge_${i}`}}));
  data.records = [...data.records.filter(r => r.kind !== 'relationship'), ...edges];
  let scans = 0;
  vault.scan = async () => { scans++; return data; };
  vault.detail = () => { throw Error('Endpoint lists must not call detail'); };
  const first = checked('records', await vault.list({kind:'relationship', includeEndpoints:true, limit:50}));
  assert.equal(scans, 1); assert.equal(first.records.length, 50); assert.equal(first.nextOffset, 50);
  assert.deepEqual(new Set(first.endpoints.map(r=>r.id)), new Set([edge.metadata.from,edge.metadata.to]));
  for (const endpoint of first.endpoints) { assert.equal(endpoint.body,undefined); assert.equal(endpoint.evidence,undefined); }
  const last = checked('records', await vault.list({kind:'relationship', includeEndpoints:true, offset:50, limit:50}));
  assert.equal(scans, 2); assert.equal(last.records.length,5); assert.equal(last.nextOffset,null);
  assert.equal((await vault.list({kind:'relationship'})).endpoints,undefined,'Projection remains opt-in');
  const target = data.records.find(r=>r.id===edge.metadata.from);
  target.lifecycle='withdrawn'; target.metadata.lifecycle='withdrawn';
  const historical = checked('records', await vault.list({kind:'relationship', lifecycle:'all', includeEndpoints:true}));
  assert.equal(historical.records.length,50);
  assert.ok(!historical.endpoints.some(r=>r.id===target.id),'History must not leak unavailable endpoint content');
  target.lifecycle='active'; target.metadata.lifecycle='active';
  data.records.push({...target,path:'duplicate.md'});
  assert.ok(!(await vault.list({kind:'relationship', lifecycle:'all', includeEndpoints:true})).endpoints.some(r=>r.id===target.id),'Ambiguous endpoint identities are withheld');
  const pages = checked('records', await vault.list({kind:'page', includeEndpoints:true}));
  assert.deepEqual(pages.endpoints,[],'Only relationships on this page contribute endpoints');
});
