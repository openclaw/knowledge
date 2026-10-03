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
import { accessFor, apiFor } from './support.mjs';
import { contract } from '../dist/contract.js';

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'knowledge-write-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'vault'); await mkdir(root); await mkdir(path.join(root, 'private'));
  const manifest = { format: 'knowledge-vault-v2', vaultId: randomUUID(), generation: 0, publicationId: randomUUID() };
  await writeFile(path.join(root, 'vault.json'), JSON.stringify(manifest));
  const config = { root, statePath: path.join(base, 'state.sqlite'), vaultId: manifest.vaultId, publicationId: manifest.publicationId, operatorRead: true, writesEnabled: true };
  const api = apiFor(base, config);
  const owner = { source: 'tool', api, tool: { agentId: 'main', memoryAudience: { kind: 'owner-private', agentId: 'main' }, assertInvocationCurrent() {}, assertMemoryAudienceCurrent() {} } };
  const operator = { source: 'session-action', api, action: { client: { connId: 'test', scopes: ['operator.write'] } } };
  const store = new SqliteIdentityStore(config.statePath), service = createKnowledgeService(api);
  const access = () => accessFor(owner, true);
  return { base, root, config, manifest, api, owner, operator, store, service, access,
    setAudience: value => { owner.tool.memoryAudience = value; } };
}
const draft = () => ({ requestId: randomUUID(), title: 'Publication test', type: 'note', body: 'Authored text.\n' });
const edit = (record, fields = {}) => ({ requestId: randomUUID(), id: record.id, expectedRevision: record.revision, expectedHash: record.hash, title: record.title, body: record.body, ...fields });


async function foundation(t) {
  const f = await fixture(t);
  f.fingerprint = (await f.service.ontology({}, f.owner)).fingerprint;
  f.pages = {};
  for (const type of ['person','project','meeting']) f.pages[type] = await f.service.save_page({ ...draft(), title: type, type }, f.owner);
  f.source = await f.service.attach({requestId:randomUUID(),filename:'meeting.txt',mediaType:'text/plain',attribution:'Meeting transcript',offset:0,data:Buffer.from('Alex: We chose option B.\nAlex: I will deliver by Friday.\nSpeaker 2: I disagree.').toString('base64'),final:true},f.owner);
  f.evidence = {...f.source.evidence,start_line:1,end_line:1,quote:'We chose option B.'};
  f.claim = (extra={}) => ({requestId:randomUUID(),expectedOntologyFingerprint:f.fingerprint,title:'Option B decision',body:'Alex chose option B.',claim_kind:'decision',assertion_origin:'source',attribution:'Alex, meeting transcript line 1',evidence:[f.evidence],entities:[f.pages.project.id],dependencies:[f.pages.meeting.id],...extra});
  f.edge = (extra={}) => ({requestId:randomUUID(),expectedOntologyFingerprint:f.fingerprint,title:'Meeting discusses project',body:'Explicit meeting/project connection',from:f.pages.meeting.id,to:f.pages.project.id,label:'discusses',attribution:'Meeting transcript',evidence:[f.evidence],...extra});
  return f;
}

test('structured UI/agent service parity: decision, owned commitment, event, edge and exact evidence', async t => {
  const f=await foundation(t);
  const decision=await f.service.create_claim(f.claim(),f.owner);
  const commitment=await f.service.create_claim(f.claim({title:'Deliver',claim_kind:'commitment',owner:f.pages.person.id,due_at:'2026-09-25',occurred_at:'2026-09-23T10:30:00-07:00'}),f.operator);
  const event=await f.service.create_claim(f.claim({title:'Historical event',claim_kind:'event',occurred_at:'2020-02-29'}),f.owner);
  const edge=await f.service.create_relationship(f.edge(),f.operator);
  for(const receipt of [decision,commitment,event,edge]) {
    assert.equal(receipt.state,'published'); assert.ok(Check(contract.operations.create_claim.output,receipt));
    const read=await f.service.record({id:receipt.id,includeMetadata:true,includeEvidence:true},f.owner);
    assert.ok(Check(contract.operations.record.output,read));assert.equal(read.evidence[0].verified,true);assert.equal(read.evidence[0].quote,'We chose option B.');
    assert.equal((await f.service.lookup({query:receipt.id},f.owner)).outcome,'found');
  }
  const m=(await f.service.record({id:commitment.id,includeMetadata:true},f.owner)).record.metadata;
  assert.equal(m.owner,f.pages.person.id); assert.equal(m.due_at,'2026-09-25');assert.equal(m.occurred_at,'2026-09-23T10:30:00-07:00');
  const outgoing=await f.service.connections({id:f.pages.meeting.id,direction:'outgoing'},f.owner);
  assert.ok(Check(contract.operations.connections.output,outgoing));assert.equal(outgoing.connections[0].record.id,edge.id);
  assert.equal((await f.service.connections({id:f.pages.project.id,direction:'incoming'},f.operator)).connections[0].from,f.pages.meeting.id);
  const reverse=await f.service.connections({id:f.pages.meeting.id,direction:'dependents',limit:1},f.owner);
  assert.equal(reverse.total,3);assert.equal(reverse.nextOffset,1);
  assert.equal((await f.service.connections({id:f.pages.person.id,direction:'claims'},f.owner)).connections[0].record.id,commitment.id);
});

test('all claim kinds roundtrip; contradictions and uncertain attribution are not merged',async t=>{
  const f=await foundation(t);
  for(const claim_kind of ['fact','preference','decision','commitment','event','belief']) for(const assertion_origin of ['source','user_belief','agent_inference']) {
    const receipt=await f.service.create_claim(f.claim({claim_kind,assertion_origin,attribution:'Unresolved Speaker 2'}),f.owner);
    const r=(await f.service.record({id:receipt.id,includeMetadata:true},f.owner)).record;
    assert.equal(r.metadata.claim_kind,claim_kind);assert.equal(r.metadata.assertion_origin,assertion_origin);assert.equal(r.metadata.owner,undefined);
  }
  const opposite=await f.service.create_claim(f.claim({body:'Speaker 2 rejects option B.'}),f.owner);
  assert.equal((await f.service.records({kind:'claim'},f.owner)).total,19);
  assert.equal((await f.service.record({id:opposite.id},f.owner)).record.body,'Speaker 2 rejects option B.');
});

test('automatic recall approval rejects source and agent-inference claims',async t=>{
  const f=await foundation(t);
  for(const assertion_origin of ['source','agent_inference']) {
    const receipt=await f.service.create_claim(f.claim({assertion_origin}),f.owner);
    const record=(await f.service.record({id:receipt.id},f.owner)).record;
    await assert.rejects(f.service.recall({requestId:randomUUID(),id:record.id,expectedRevision:record.revision,expectedHash:record.hash,set:{summary:'Do not approve this claim automatically.'}},f.owner),/externally sourced or agent-inferred/);
  }
  const receipt=await f.service.create_claim(f.claim({assertion_origin:'user_belief',attribution:'Josh, direct owner statement'}),f.owner);
  const record=(await f.service.record({id:receipt.id},f.owner)).record;
  const approved=await f.service.recall({requestId:randomUUID(),id:record.id,expectedRevision:record.revision,expectedHash:record.hash,set:{summary:'Josh prefers option B.',triggers:['option B']}},f.owner);
  assert.equal(approved.state,'published');
});

for(const operation of ['create_claim','create_relationship']) for(const stage of ['after-accept','after-link:vault.json','before-receipt']) test(`${operation}: interrupted ${stage}, replacement retry and changed payload`,async t=>{
  const f=await foundation(t), input=operation==='create_claim'?f.claim():f.edge();
  const publisher=new Publisher(f.config,f.store,where=>{if(where===stage)throw Error('crash');});
  const method=operation==='create_claim'?'createClaim':'createRelationship';
  await assert.rejects(publisher[method](input,f.access(),'agent'),/crash/);
  const resumed=await createKnowledgeService(f.api)[operation](input,f.owner);
  assert.equal(resumed.state,'published');assert.deepEqual(await f.service[operation](input,f.owner),resumed);
  await assert.rejects(f.service[operation]({...input,title:'Different'},f.owner),/different payload/);
  await assert.rejects(f.service.save_page({...draft(),requestId:input.requestId},f.owner),/different payload/);
  assert.equal((await f.service.records({kind:operation==='create_claim'?'claim':'relationship'},f.owner)).total,1);
});

test('malformed writes and references fail before acceptance with no source mutation',async t=>{
  const f=await foundation(t);
  for(const change of [
    {evidence:[]},{evidence:[{...f.evidence,quote:'not in source'}]}, {evidence:[{...f.evidence,end_line:999}]},
    {claim_kind:undefined},{assertion_origin:undefined},{attribution:' '},{body:' '}, {expectedOntologyFingerprint:'0'.repeat(64)},
    {entities:[randomUUID()]},{owner:f.pages.person.id},{due_at:'2026-09-30'}, {occurred_at:'2026-02-30'},
    {occurred_at:'2026-09-23T10:00:00'}, {occurred_at:'2026-09-23T24:00:00Z'},
    {valid_from:'2026-09-23T00:00:00Z',valid_until:'2026-09-22T00:00:00Z'},
    {lifecycle:'withdrawn'}, {id:randomUUID()}
  ]) {
    const input=f.claim(change); await assert.rejects(f.service.create_claim(input,f.owner));
    assert.equal((await f.service.mutation({requestId:input.requestId},f.owner)).receipt,null);
  }
  const c=await f.service.create_claim(f.claim(),f.owner);
  await assert.rejects(f.service.create_relationship(f.edge({from:c.id}),f.owner),/pages/);
  await assert.rejects(f.service.create_relationship(f.edge({label:'not_declared'}),f.owner),/ontology/);
  await assert.rejects(f.service.create_relationship(f.edge({label:'leads'}),f.owner),/endpoint-type/);
  assert.equal((await f.service.records({kind:'relationship'},f.owner)).total,0);
});

test('temporal active retrieval and connections agree; explicit history keeps expired assertions',async t=>{
  const f=await foundation(t);
  const expired=await f.service.create_claim(f.claim({expires_at:'2000-01-01T00:00:00Z'}),f.owner);
  const future=await f.service.create_relationship(f.edge({valid_from:'2099-01-01T00:00:00Z'}),f.owner);
  const ended=await f.service.create_claim(f.claim({valid_until:'2000-01-01T00:00:00Z'}),f.owner);
  for(const r of [expired,future,ended]) {
    assert.equal((await f.service.lookup({query:r.id},f.owner)).outcome,'missing');
    assert.equal((await f.service.lookup({query:r.id,lifecycle:'all'},f.owner)).outcome,'found');
    assert.ok((await f.service.record({id:r.id},f.owner)).record);
    await assert.rejects(f.service.create_claim(f.claim({dependencies:[r.id]}),f.owner),/unavailable/);
  }
  assert.equal((await f.service.grep({query:'option'},f.owner)).total,0);
  assert.equal((await f.service.grep({query:'option',lifecycle:'all'},f.owner)).total,2);
  assert.equal((await f.service.connections({id:f.pages.project.id},f.owner)).total,0);
  assert.equal((await f.service.connections({id:f.pages.project.id,historical:true},f.owner)).total,3);
});

test('metadata omission preserves, empty clears, authored fields/comments survive, aliases stay ambiguous',async t=>{
  const f=await foundation(t);
  let r=(await f.service.record({id:f.pages.person.id},f.owner)).record;
  await f.service.save_page(edit(r,{aliases:['Alex'],tags:['team'],dependencies:[f.pages.meeting.id],fields:{role:'Engineer'}}),f.owner);
  r=(await f.service.record({id:r.id},f.owner)).record;
  await f.service.save_page(edit(r,{title:'Alex person'}),f.owner);
  let m=(await f.service.record({id:r.id,includeMetadata:true},f.owner)).record.metadata;
  assert.deepEqual(m.aliases,['Alex']);assert.deepEqual(m.dependencies,[f.pages.meeting.id]);
  await f.service.save_page({...draft(),aliases:['Alex']},f.owner);
  assert.equal((await f.service.lookup({query:'Alex'},f.owner)).outcome,'ambiguous');
  r=(await f.service.record({id:r.id},f.owner)).record;
  await f.service.save_page(edit(r,{aliases:[],tags:[],dependencies:[]}),f.owner);
  m=(await f.service.record({id:r.id,includeMetadata:true},f.owner)).record.metadata;
  assert.deepEqual(m.aliases,[]);assert.deepEqual(m.tags,[]);assert.deepEqual(m.dependencies,[]);assert.deepEqual(m.fields,{role:'Engineer'});
});

test('new mutations and connections obey scope, read-only authority and historical withdrawal ledger',async t=>{
  const f=await foundation(t), input=f.claim(), receipt=await f.service.create_claim(input,f.owner);
  const sequence=(await f.service.history({id:receipt.id},f.owner)).entries[0].sequence;
  const readOnly={...f.operator,action:{client:{connId:'readonly',scopes:['operator.read']}}};
  await assert.rejects(f.service.create_claim(f.claim(),readOnly),/authority/);
  const original=await readFile(path.join(f.root,'private',receipt.path),'utf8');
  await writeFile(path.join(f.root,'private',receipt.path),original.replace('lifecycle: active','lifecycle: withdrawn'));
  assert.equal((await f.service.connections({id:f.pages.project.id,historical:true},f.owner)).total,0);
  await writeFile(path.join(f.root,'private',receipt.path),original);
  assert.equal((await f.service.connections({id:f.pages.project.id,historical:true},f.owner)).total,0);
  f.setAudience({kind:'conversation',agentId:'main',sessionKey:'agent:main:group',sessionId:randomUUID()});
  await assert.rejects(f.service.create_claim(f.claim(),f.owner),/unavailable/);
  await assert.rejects(f.service.create_relationship(f.edge(),f.owner),/unavailable/);
  assert.equal((await f.service.connections({id:f.pages.project.id,historical:true},f.owner)).total,0);
  assert.equal((await f.service.revision({sequence},f.owner)).raw,null);
});

for (const target of ['reference','evidence']) test(`fences ${target} changes between preview and acceptance`,async t=>{
  const f=await foundation(t), input=f.claim();
  const relative=target==='reference'?f.pages.project.path:f.evidence.path;
  const full=path.join(f.root,'private',relative), original=await readFile(full,'utf8');
  const publisher=new Publisher(f.config,f.store,stage=>{if(stage==='before-accept')writeFileSync(full,original+'\nExternal change');});
  await assert.rejects(publisher.createClaim(input,f.access(),'agent'));
  assert.equal((await f.service.mutation({requestId:input.requestId},f.owner)).receipt,null);
  assert.equal((await f.service.records({kind:'claim'},f.owner)).total,0);
});
