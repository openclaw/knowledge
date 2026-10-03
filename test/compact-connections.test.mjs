import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Check } from 'typebox/value';
import { connections, CONNECTION_RESPONSE_BYTES } from '../dist/connections.js';
import { ConnectionsOutput } from '../dist/connections-contract.js';
const rec = (id, extra = {}) => ({ id, title: id, kind: 'page', type: 'person', path: `people/${id}.md`, hash: id, revision: 1, lifecycle: 'active', valid: true, body: '', raw: '', metadata: { lifecycle: 'active', ...extra } });
const fixture = (count = 1) => ({ records: [rec('a'), rec('b'), ...Array.from({length:count}, (_,i) => ({...rec(`edge-${i}`, {from:'a',to:'b',label:'attended', attribution_confidence:{level:'low',basis:'Speaker unresolved',evidence:[{path:'source.txt',sha256:'a'.repeat(64),quote:'expensive'.repeat(1500)}]}}),kind:'relationship',type:'attended'}))], issues: [] });
const checked = r => { assert.ok(Check(ConnectionsOutput,r)); assert.ok(Buffer.byteLength(JSON.stringify(r)) <= CONNECTION_RESPONSE_BYTES); return r; };
test('compact default retains uncertainty and graph identity without evidence; rich response remains explicit', () => {
 const data=fixture(); const small=checked(connections(data,{id:'a',includeEndpoints:true})), full=checked(connections(data,{id:'a',view:'full',includeEndpoints:true}));
 assert.equal(small.snapshot,full.snapshot); assert.equal(small.total,full.total);
 assert.equal(small.connections[0].from,'a'); assert.equal(small.connections[0].record.attributionConfidence.level,'low');
 assert.equal(small.connections[0].record.attributionConfidence.evidence,undefined);
 assert.equal(small.connections[0].record.path,undefined); assert.equal(small.connections[0].evidence,undefined);
 assert.equal(small.endpoints[0].path,undefined); assert.ok(full.connections[0].record.path);
 assert.equal(full.connections[0].record.attributionConfidence.evidence.length,1);
});
test('byte-bounded pages remain valid and exhaustive with Unicode, escaping and deduplicated endpoints', () => {
 const data=fixture(80); for (const r of data.records) r.title='"東京\\'.repeat(35);
 for (const view of ['compact','full']) {
  let offset=0, ids=[]; do {
   const page=checked(connections(data,{id:'a',view,includeEndpoints:true,limit:100,offset}));
   assert.ok(page.connections.length); assert.ok(page.connections.length<80);
   assert.equal(page.endpoints.length,2); ids.push(...page.connections.map(r=>r.record.id));
   if(page.nextOffset!==null) assert.equal(page.nextOffset,offset+page.connections.length);
   offset=page.nextOffset;
  } while(offset!==null);
  assert.equal(ids.length,80); assert.equal(new Set(ids).size,80);
 }
});
test('one oversized full row fails explicitly; default still works', () => {
 const data=fixture(); data.records[2].metadata.attribution_confidence.evidence[0].quote='x'.repeat(30000);
 assert.throws(()=>connections(data,{id:'a',view:'full'}),/response budget/);
 assert.equal(checked(connections(data,{id:'a'})).connections.length,1);
});
