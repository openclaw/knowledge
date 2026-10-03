import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Check } from 'typebox/value';
import { recentActivity, RecentOutput } from '../dist/recent.js';
// Exercise the installed host's actual boundary, not a copy of our budget helper.
import { isPluginJsonValue } from '../node_modules/openclaw/src/plugins/host-hook-json.ts';

function fixture(t, groups, count, evidenceCount = 10, body = 'Synthetic claim.', quote = '') {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE history(sequence INTEGER PRIMARY KEY, scope TEXT,id TEXT,hash TEXT,revision INTEGER,provenance TEXT,at TEXT);
    CREATE TABLE mutations(scope TEXT,state TEXT,request TEXT,receipt TEXT,plan TEXT);`);
  const active = [], at = '2026-10-01T00:00:00Z';
  const add = (id, kind, type, extra = {}) => {
    const record = { id,title:id,kind,type,path:`${id}.md`,lifecycle:'active',revision:1,valid:true,hash:'a'.repeat(64),raw:'',body,
      metadata:{recorded_at:at,updated_at:at,...extra} };
    active.push(record);
    db.prepare('INSERT INTO history VALUES (?,?,?,?,?,?,?)').run(active.length,'shared',id,record.hash,1,'test',at);
    return record;
  };
  for (let g=0; g<groups; g++) {
    const source=add(`source-${g}`,'page','meeting');
    for(let c=0;c<count;c++) add(`claim-${g}-${c}`,'claim','fact',{
      source_page:source.id,claim_kind:'fact',assertion_origin:'source',
      attribution_confidence:{level:'medium',basis:'Synthetic evidence',evidence:Array.from({length:evidenceCount},()=>({path:'sources/sample.txt',sha256:'b'.repeat(64),start_line:1,end_line:2,...(quote ? {quote} : {})}))}
    });
  }
  return {db,active};
}
function valid(value) {
  const json=JSON.parse(JSON.stringify(value));
  assert.ok(Check(RecentOutput,json),'Recent schema');
  assert.ok(isPluginJsonValue(json),'real host JSON limit');
  return json;
}

for (const [name,evidenceCount,body] of [['nodes',10,'Synthetic claim.'],['bytes',1,'界'.repeat(4000)]]) {
  test(`Recent paginates ${name} without skipping or duplicating source groups`,t=>{
    const {db,active}=fixture(t,10,20,evidenceCount,body);
    const seen=[];let beforeSequence,upperSequence;
    do {
      const page=valid(recentActivity(db,'shared',active,{groupBySource:true,includeEndpoints:true,limit:50,beforeSequence,upperSequence}));
      assert.ok(page.items.length>0 && page.items.length<10);
      seen.push(...page.items.map(item=>item.group.source.id));
      beforeSequence=page.nextBefore;upperSequence=page.upperSequence;
    } while(beforeSequence!=null);
    assert.equal(seen.length,10);assert.equal(new Set(seen).size,10);
  });
}

for (const quote of ['', '界'.repeat(4000)]) test(`oversized source uses inner continuation${quote ? ' with summary-only fallback' : ''}`,t=>{
  const {db,active}=fixture(t,1,25,20,'Synthetic claim.',quote);
  const seen=[];let recordOffset=0,upperSequence;
  do {
    const page=valid(recentActivity(db,'shared',active,{groupBySource:true,includeEndpoints:true,sourceId:'source-0',recordOffset,upperSequence}));
    const group=page.items[0].group;
    assert.ok(group.records.length>0);assert.equal(page.nextBefore,null);
    seen.push(...group.records.map(r=>r.id));
    if(recordOffset===0 && quote) assert.equal(group.records[0].card,undefined,'huge preview becomes clickable summary');
    recordOffset=group.nextRecordOffset;upperSequence=page.upperSequence;
    assert.equal(group.truncated,recordOffset!=null);
  } while(recordOffset!=null);
  assert.equal(seen.length,26);assert.equal(new Set(seen).size,26);
});
