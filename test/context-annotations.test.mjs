import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Check } from 'typebox/value';
import { Publisher } from '../dist/publisher.js';
import { SqliteIdentityStore } from '../dist/identity-store.js';
import { createKnowledgeService } from '../dist/service.js';
import { authorizeVault } from '../dist/access.js';
import { contract } from '../dist/contract.js';

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'knowledge-write-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'vault'); await mkdir(root); await mkdir(path.join(root, 'private'));
  const manifest = { format: 'knowledge-vault-v1', vaultId: randomUUID(), agentId: 'main', generation: 0, publicationId: randomUUID() };
  await writeFile(path.join(root, 'vault.json'), JSON.stringify(manifest));
  const config = { root, statePath: path.join(base, 'state.sqlite'), agentId: 'main', vaultId: manifest.vaultId, publicationId: manifest.publicationId, operatorRead: true, writesEnabled: true };
  let entry = { sessionId: randomUUID(), chatType: 'direct' };
  const api = { pluginConfig: { vault: config }, runtime: { agent: { session: { getSessionEntry: () => entry } } } };
  const owner = { source: 'tool', api, tool: { agentId: 'main', sessionId: entry.sessionId, sessionKey: 'agent:main:write-test', senderIsOwner: true, assertInvocationCurrent() {} } };
  const operator = { source: 'session-action', api, action: { client: { connId: 'test', scopes: ['operator.write'] } } };
  const store = new SqliteIdentityStore(config.statePath), service = createKnowledgeService(api);
  const access = () => authorizeVault(owner, 'main', true, true);
  return { base, root, config, manifest, api, owner, operator, store, service, access, setEntry: v => { entry = v; } };
}

async function setup(t) {
  const f = await fixture(t);
  f.fingerprint = (await f.service.ontology({}, f.owner)).fingerprint;
  f.page = async (title, type='meeting') => f.service.save_page({requestId:randomUUID(),title,type,body:`Source context for ${title}.`}, f.owner);
  f.source = await f.page('Meeting A');
  const upload = await f.service.attach({requestId:randomUUID(),filename:'source.txt',mediaType:'text/plain',attribution:'Synthetic isolated source',offset:0,data:Buffer.from('Alex will investigate.\nAlex reaffirms the investigation.').toString('base64'),final:true},f.owner);
  f.evidence = [{...upload.evidence,start_line:1,end_line:1}];
  f.claim = async (extra={}) => f.service.create_claim({requestId:randomUUID(),expectedOntologyFingerprint:f.fingerprint,title:'Investigate',body:'Alex will investigate.',claim_kind:'commitment',assertion_origin:'source',attribution:'Alex, source line 1',evidence:f.evidence,source_page:f.source.id,...extra},f.owner);
  f.annotate = async (id,annotations,extra={}) => {
    const r=(await f.service.record({id,includeMetadata:true},f.owner)).record;
    const input={requestId:randomUUID(),id,expectedRevision:r.revision,expectedHash:r.hash,reason:'Evidence-backed context update',annotations,...extra};
    const result=await f.service.annotate(input,f.owner);
    assert.ok(Check(contract.operations.annotate.output,result));return {input,result};
  };
  return f;
}

test('context annotations preserve assertion text/lifecycle, append evidence, and fence retries/conflicts',async t=>{
  const f=await setup(t), original=await f.claim();
  const second=await f.claim({body:'Alex reaffirmed the investigation.',title:'Reaffirmed investigation'});
  const {input,result}=await f.annotate(second.id,{continuity:[{id:original.id,relation:'reaffirms',basis:'Explicit reaffirmation in the next source line',evidence:f.evidence}]},{addEvidence:f.evidence});
  const read=await f.service.record({id:second.id,includeMetadata:true},f.owner);
  assert.equal(read.record.body,'Alex reaffirmed the investigation.');
  assert.equal(read.record.lifecycle,'active');assert.equal(read.record.metadata.supersedes,undefined);
  assert.equal(read.record.metadata.evidence.length,1,'Identical support is not duplicated');
  assert.equal(read.record.metadata.continuity[0].id,original.id);
  assert.equal(read.relatedStatements[0].incoming,false);
  const reverse=await f.service.record({id:original.id},f.owner);
  assert.equal(reverse.relatedStatements[0].record.id,second.id);
  assert.equal(reverse.relatedStatements[0].incoming,true);
  assert.equal(reverse.relatedStatements[0].source.id,f.source.id);
  const inventory=await f.service.records({kind:'claim',query:'reaffirmed'},f.owner);
  assert.equal(inventory.total,1);assert.equal(inventory.facets.kinds.commitment,2);assert.equal(inventory.facets.origins.source,2);
  assert.equal((await f.service.records({kind:'claim',assertionOrigin:'agent_inference'},f.owner)).total,0);
  assert.equal((await f.service.annotate(input,f.owner)).revision,result.revision,'Replay retains the accepted mutation');
  await assert.rejects(f.service.annotate({...input,requestId:randomUUID()},f.owner),/conflict/);
  await assert.rejects(f.service.annotate({...input,annotations:{body:'Changed meaning'}},f.owner),/Invalid/);
  await assert.rejects(f.service.annotate(input,f.operator),/chat/);
  assert.equal((await f.service.record({id:original.id},f.owner)).record.lifecycle,'active');
});

test('uncertain identity and attribution retain evidence; cross-scope guesses and forged evidence are rejected',async t=>{
  const f=await setup(t), person=await f.page('Alex','person'), candidate=await f.page('Alex Candidate','person');
  await f.annotate(person.id,{identity:{status:'partial',context:'Source handle only',candidates:[{id:candidate.id,basis:'Possible spelling match; not a resolved identity',evidence:f.evidence}]}});
  const claim=await f.claim();
  await f.annotate(claim.id,{attribution_confidence:{level:'medium',basis:'Direct roll call; source track remains uncertain',evidence:f.evidence}});
  await assert.rejects(f.annotate(person.id,{identity:{status:'partial',context:'Unknown',candidates:[{id:randomUUID(),basis:'Guessed hidden person',evidence:f.evidence}]}}),/reference/);
  await assert.rejects(f.annotate(claim.id,{attribution_confidence:{level:'high',basis:'Bad evidence',evidence:[{...f.evidence[0],sha256:'0'.repeat(64)}]}}),/hash|match/i);
  const read=await f.service.record({id:person.id,includeMetadata:true},f.owner);
  assert.equal(read.record.metadata.identity.status,'partial');
  assert.equal((await f.service.records({type:'person'},f.owner)).total,2,'Candidates never merge identities');
});

test('fixture classification consistently removes records from current views without erasing exact/history access',async t=>{
  const f=await setup(t), claim=await f.claim({title:'Fixture canary'});
  await f.annotate(claim.id,{record_class:'fixture'});
  assert.equal((await f.service.records({kind:'claim'},f.owner)).total,0);
  assert.equal((await f.service.lookup({query:'Fixture canary'},f.owner)).total,0);
  assert.equal((await f.service.grep({query:'Fixture canary'},f.owner)).total,0);
  assert.equal((await f.service.connections({id:f.source.id},f.owner)).connections.some(r=>r.record.id===claim.id),false);
  assert.equal((await f.service.recent({},f.owner)).items.some(r=>r.id===claim.id),false);
  assert.equal((await f.service.records({kind:'claim',lifecycle:'all'},f.owner)).total,1);
  const exact=await f.service.record({id:claim.id,includeMetadata:true},f.owner);
  assert.equal(exact.record.body,'Alex will investigate.');assert.equal(exact.record.metadata.record_class,'fixture');
  assert.ok((await f.service.history({id:claim.id},f.owner)).entries.length>=2);
});

test('new records with shared annotation evidence serialize without YAML aliases and remain readable',async t=>{
  const f=await setup(t), person=await f.page('Alex','person'), company=await f.page('Example','company');
  const confidence={level:'high',basis:'Explicit self-introduction',evidence:f.evidence};
  const claim=await f.claim({attribution_confidence:confidence});
  const relationship=await f.service.create_relationship({requestId:randomUUID(),expectedOntologyFingerprint:f.fingerprint,
    from:person.id,to:company.id,label:'works_at',title:'Alex works at Example',body:'Alex reports working at Example.',
    attribution:'Isolated synthetic source',evidence:f.evidence,attribution_confidence:confidence},f.owner);
  const page=await f.service.save_page({requestId:randomUUID(),type:'person',title:'Another person',body:'Source-qualified profile.',
    attachments:f.evidence,attribution_confidence:confidence},f.owner);
  for(const receipt of [claim,relationship,page]) {
    const read=await f.service.record({id:receipt.id,includeMetadata:true},f.owner);
    assert.ok(read.record,'Published serialization must survive an independent vault scan');
    assert.equal(read.record.valid,true);
    assert.equal(read.evidence[0].verified,true);
    assert.deepEqual(read.record.metadata.evidence,read.record.metadata.attribution_confidence.evidence);
  }
  const next=await f.claim(), third=await f.claim();
  const continuity=[next,third].map(r=>({id:r.id,relation:'reaffirms',basis:'Same source context',evidence:f.evidence}));
  await f.annotate(claim.id,{continuity});
  assert.equal((await f.service.record({id:claim.id,includeMetadata:true},f.owner)).record.metadata.continuity.length,2);
  const saved=(await f.service.record({id:page.id},f.owner)).record;
  const candidate=await f.page('Alex candidate','person');
  const identity={status:'partial',context:'Unresolved source name',candidates:[person,candidate].map(r=>({id:r.id,basis:'Possible name match',evidence:f.evidence}))};
  await f.service.save_page({requestId:randomUUID(),id:page.id,expectedRevision:saved.revision,expectedHash:saved.hash,
    title:saved.title,body:saved.body,identity},f.owner);
  assert.equal((await f.service.record({id:page.id,includeMetadata:true},f.owner)).record.metadata.identity.candidates.length,2);
  assert.equal((await f.service.diagnostics({},f.owner)).total,0);
});

test('source groups are counted before pagination; repeated saves and new activity do not split a source group',async t=>{
  const f=await setup(t), sourceB=await f.page('Meeting B');
  await f.claim({source_page:sourceB.id,title:'Other source commitment'});
  for(let i=0;i<23;i++) await f.claim({title:`Meeting A commitment ${i}`});
  const first=await f.service.recent({groupBySource:true,limit:1},f.owner);
  assert.ok(Check(contract.operations.recent.output,first));
  assert.equal(first.items.length,1);assert.equal(first.items[0].group.source.id,f.source.id);
  assert.equal(first.items[0].group.counts.commitment,23);
  assert.equal(first.items[0].group.total,24,'Source page and twenty-three distinct claims');
  const continuation=await f.service.recent({groupBySource:true,sourceId:f.source.id,recordOffset:first.items[0].group.nextRecordOffset,upperSequence:first.upperSequence},f.owner);
  assert.equal(continuation.items[0].group.records.length,4);assert.equal(continuation.items[0].group.nextRecordOffset,null);
  assert.equal(new Set([...first.items[0].group.records,...continuation.items[0].group.records].map(r=>r.id)).size,24);
  assert.ok(first.items[0].group.records.some(r=>r.card?.body));
  await f.claim({title:'New activity after the pinned upper sequence'});
  const next=await f.service.recent({groupBySource:true,limit:1,upperSequence:first.upperSequence,beforeSequence:first.nextBefore},f.owner);
  assert.equal(next.items[0].group.source.id,sourceB.id);
  assert.equal(next.items[0].group.counts.commitment,1);
  assert.equal(next.nextBefore,null);
});

test('Recent batches attendee summaries only for the current group page',async t=>{
  const f=await setup(t), person=await f.page('Alex','person');
  for(let i=0;i<21;i++) await f.service.create_relationship({requestId:randomUUID(),expectedOntologyFingerprint:f.fingerprint,title:`Attendance ${i}`,body:'Alex attended.',from:person.id,to:f.source.id,label:'attended',evidence:f.evidence,attribution:'Synthetic fixture',source_page:f.source.id},f.owner);
  const input={groupBySource:true,sourceId:f.source.id,includeEndpoints:true,limit:1};
  const first=await f.service.recent(input,f.owner);
  assert.ok(Check(contract.operations.recent.output,first));
  const group=first.items[0].group;
  assert.equal(group.records.length,20);
  assert.deepEqual(new Set(group.endpoints.map(r=>r.id)),new Set([person.id,f.source.id]));
  assert.ok(group.endpoints.every(r=>r.body===undefined && r.evidence===undefined));
  const next=await f.service.recent({...input,recordOffset:group.nextRecordOffset,upperSequence:first.upperSequence},f.owner);
  assert.equal(next.items[0].group.records.length,2);
  assert.deepEqual(new Set(next.items[0].group.endpoints.map(r=>r.id)),new Set([person.id,f.source.id]));
  assert.equal((await f.service.recent({...input,includeEndpoints:false},f.owner)).items[0].group.endpoints,undefined);
  const record=(await f.service.record({id:person.id},f.owner)).record;
  await f.service.withdraw({requestId:randomUUID(),id:person.id,expectedRevision:record.revision,expectedHash:record.hash,reason:'Fixture withdrawal'},f.owner);
  const after=await f.service.recent({...input,upperSequence:first.upperSequence},f.owner);
  assert.ok(after.items.every(item=>!item.group?.endpoints.some(r=>r.id===person.id)),'Pinned history cannot expose a now-withdrawn endpoint');
});
