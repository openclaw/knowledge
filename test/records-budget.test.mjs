import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Check } from 'typebox/value';
import { SampleVault } from '../dist/vault.js';
import { contract } from '../dist/contract.js';
import { isPluginJsonValue } from '../node_modules/openclaw/src/plugins/host-hook-json.ts';

async function fixture(count, evidenceCount, body, quote = '') {
  const vault = new SampleVault(), data = await vault.scan();
  const template = data.records.find(r => r.id === 'sample_claim_pilot');
  const evidence = Array.from({length:evidenceCount}, () => ({path:'sources/sample.txt',sha256:'a'.repeat(64),start_line:1,end_line:2,...(quote ? {quote} : {})}));
  const claims = Array.from({length:count}, (_, i) => ({...template,id:i===0 ? template.id : `claim_${String(i).padStart(3,'0')}`,title:`Claim ${i}`,body,metadata:{...template.metadata,attribution_confidence:{level:'medium',basis:'Synthetic attribution',evidence}}}));
  data.records = [...data.records.filter(r=>r.kind!=='claim'),...claims];
  let scans = 0;
  vault.scan = async () => { scans++; return data; };
  return {vault,data,claims,scans:()=>scans};
}
function valid(result) {
  assert.ok(Check(contract.operations.records.output,result),'records contract');
  assert.ok(isPluginJsonValue(result),'actual host nested-value and byte limits');
  return result;
}
for (const [name,evidenceCount,body] of [['nodes',20,'Synthetic claim.'],['utf8 bytes',1,'界'.repeat(4000)]]) {
  test(`Browse bounds ${name} and continues without gaps or duplicates`,async()=>{
    const {vault,claims,scans}=await fixture(80,evidenceCount,body);
    const seen=[];let offset=0,calls=0;
    do {
      const result=valid(await vault.list({kind:'claim',includeCards:true,limit:50,offset}));calls++;
      assert.equal(result.offset,offset);assert.equal(result.total,80);
      assert.ok(result.records.length>0 && result.records.length<50);
      assert.equal(result.facets.kinds[claims[0].type],80);
      assert.equal(result.nextOffset,offset+result.records.length<80 ? offset+result.records.length:null);
      seen.push(...result.records.map(r=>r.id));offset=result.nextOffset;
    } while(offset!==null);
    assert.equal(scans(),calls,'one authorized scan per page');
    assert.deepEqual(seen,claims.map(r=>r.id).sort((a,b)=>a.localeCompare(b)));
  });
}
test('single oversized Browse claim retains a clickable summary and attribution uncertainty',async()=>{
  const {vault}=await fixture(2,20,'Synthetic claim.','界'.repeat(4000));
  const first=valid(await vault.list({kind:'claim',includeCards:true,limit:50}));
  assert.equal(first.records.length,1);assert.equal(first.nextOffset,1);
  assert.equal(first.records[0].card,undefined);
  assert.deepEqual(first.records[0].attributionConfidence,{level:'medium',basis:'Synthetic attribution'});
  const last=valid(await vault.list({kind:'claim',includeCards:true,offset:first.nextOffset}));
  assert.equal(last.nextOffset,null);assert.notEqual(last.records[0].id,first.records[0].id);
});
test('relationship endpoint payload participates in the Browse budget',async()=>{
  const vault=new SampleVault(), data=await vault.scan();
  vault.scan=async()=>data;
  const endpoints=data.records.filter(r=>r.kind==='page').slice(0,2);
  for(const r of endpoints) r.metadata.attribution_confidence={level:'low',basis:'Synthetic uncertainty',evidence:Array.from({length:20},()=>({path:'sources/sample.txt',sha256:'b'.repeat(64),start_line:1,end_line:2,quote:'界'.repeat(4000)}))};
  const edge=data.records.find(r=>r.kind==='relationship');
  data.records=[...data.records.filter(r=>r.kind!=='relationship'),...Array.from({length:3},(_,i)=>({...edge,id:`edge_${i}`,metadata:{...edge.metadata,from:endpoints[0].id,to:endpoints[1].id}}))];
  const seen=[];let offset=0;
  do {
    const result=valid(await vault.list({kind:'relationship',includeEndpoints:true,offset}));
    assert.equal(result.records.length,1);assert.equal(result.endpoints.length,2);
    assert.ok(result.endpoints.every(r=>r.attributionConfidence.level==='low'));
    seen.push(result.records[0].id);offset=result.nextOffset;
  } while(offset!==null);
  assert.equal(new Set(seen).size,3);
});
