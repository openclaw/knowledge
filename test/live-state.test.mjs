import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, writeFile, rm, rename, symlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { LiveState } from '../dist/live-state.js';
import { DraftStore } from '../dist/drafts.js';
import { createKnowledgeService } from '../dist/service.js';

async function fixture(t) {
  const base = await realpath(await mkdtemp('/tmp/knowledge-live-'));
  t.after(() => rm(base, {recursive:true,force:true}));
  const root = base + '/vault'; await mkdir(root + '/private', {recursive:true});
  const manifest = {format:'knowledge-vault-v1',vaultId:randomUUID(),agentId:'main',generation:0,publicationId:randomUUID()};
  await writeFile(root+'/vault.json',JSON.stringify(manifest));
  const services=[]; const emitted=[];
  const api={pluginConfig:{vault:{root,statePath:base+'/state.sqlite',agentId:'main',vaultId:manifest.vaultId,publicationId:manifest.publicationId,operatorRead:true,writesEnabled:true}},registerService:s=>services.push(s)};
  const service=createKnowledgeService(api,{emit:(...args)=>emitted.push(args)});
  const context={source:'session-action',api,action:{client:{connId:'test',scopes:['operator.write']}}};
  t.after(()=>services.forEach(s=>s.stop()));
  return {base,root,services,emitted,service,context};
}
async function until(fn) { for(let i=0;i<100;i++){if(fn())return; await delay(25);} assert.fail('Expected watcher notification'); }

test('external changes invalidate; events contain no data; authorized reads reconcile edits/renames/deletions',async t=>{
  const f=await fixture(t); f.services[0].start();
  const r=await f.service.save_page({requestId:randomUUID(),title:'Live fixture',type:'note',body:'Original'},f.context);
  await until(()=>f.emitted.length); await delay(200); f.emitted.length=0;
  const original=(await f.service.record({id:r.id,view:'raw'},f.context)).record.raw;
  const file=f.root+'/private/'+r.path;
  await writeFile(file,original.replace('Original','External edit'));
  await until(()=>f.emitted.length); assert.deepEqual(f.emitted[0],['changed',{}]);
  assert.equal((await f.service.record({id:r.id},f.context)).record.body,'External edit');
  await delay(200); f.emitted.length=0; await rename(file,file+'-renamed.md');
  await until(()=>f.emitted.length);
  assert.equal((await f.service.record({id:r.id},f.context)).record.path,r.path+'-renamed.md');
  await delay(200); f.emitted.length=0; await rm(file+'-renamed.md'); // Native watchers can coalesce rapid rename/delete; periodic UI reads cover this.
  assert.equal((await f.service.record({id:r.id},f.context)).record,null);
});

test('watcher stop cancels queued events; restart has one subscription; unrelated scopes stay silent',async t=>{
  const f=await fixture(t), live=new LiveState(f.root,()=>f.emitted.push('event')); t.after(()=>live.stop());
  live.start(); live.invalidate(); live.stop(); await delay(220); assert.equal(f.emitted.length,0);
  live.start(); live.start(); live.invalidate(); live.invalidate(); await until(()=>f.emitted.length); assert.equal(f.emitted.length,1);
  await mkdir(f.root+'/conversations'); await writeFile(f.root+'/conversations/foreign.txt','private to a conversation');
  await delay(250); assert.equal(f.emitted.length,1);
  await mkdir(f.root+'/private/.knowledge-history'); await writeFile(f.root+'/private/.knowledge-history/stage','hidden');
  await delay(250); assert.equal(f.emitted.length,1);
});

test('watch failures are visible and unsafe roots are not watched',async t=>{
  const f=await fixture(t); await symlink(f.root,f.base+'/alias');
  const live=new LiveState(f.base+'/alias',()=>assert.fail('unsafe watch')); live.start();
  assert.equal(live.state,'unavailable'); live.stop(); assert.equal(live.state,'stopped');
});

test('retired services fence new and in-flight operations, leaving no accepted write',async t=>{
  const f=await fixture(t); f.services[0].start();
  await f.service.status({},f.context);
  const request={requestId:randomUUID(),title:'Fenced',type:'note',body:'Never accepted'};
  const pending=f.service.save_page(request,f.context); f.services[0].stop(); f.services[0].start();
  await assert.rejects(pending,/reloaded/);
  assert.equal((await f.service.mutation({requestId:request.requestId},f.context)).receipt,null);
  f.services[0].stop(); await assert.rejects(f.service.status({},f.context),/reloaded/);
  await assert.rejects(f.service.save_page(request,f.context),/reloaded/);
  for (const operation of ['grep','lookup']) await assert.rejects(f.service[operation]({query:'Fenced'},f.context),/reloaded/);
});

test('draft recovery isolates vault/agent/scope and preserves exact uncertain-save payload and base',()=>{
  const values=new Map(); const storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
  const identity={agent:'main',vault:'one',scope:'agent-private'};
  const draft={version:1,key:randomUUID(),title:'Unsaved',body:'Exact text',type:'note',fields:'{}',source:'Source',attribution:'Test',base:{id:randomUUID(),revision:3,hash:'abc'},submitted:{requestId:randomUUID(),title:'Submitted text',body:'Original submission',type:'note'}};
  new DraftStore(identity,storage).write(draft); assert.deepEqual(new DraftStore(identity,storage).read(),draft);
  for(const changed of [{vault:'two'},{agent:'other'},{scope:'conversation:other'}]) assert.equal(new DraftStore({...identity,...changed},storage).read(),undefined);
  const store=new DraftStore(identity,storage); store.remove('wrong-key'); assert.deepEqual(store.read(),draft); store.remove(draft.key); assert.equal(store.read(),undefined);
});

test('corrupt/oversized draft and unavailable storage fail explicitly without clearing data',()=>{
  let raw='{broken'; const storage={getItem:()=>raw,setItem:()=>{throw Error('quota')},removeItem:()=>assert.fail('must preserve')};
  const store=new DraftStore({agent:'main',vault:'one',scope:'private'},storage);
  assert.throws(()=>store.read()); raw='x'.repeat(400001); assert.throws(()=>store.read(),/large/);
  assert.throws(()=>store.write({version:1}),/quota/);
});


test('browser vault precondition cannot redirect a retained draft to a replacement vault',async t=>{
  const f=await fixture(t); await f.service.status({},f.context);
  const request={requestId:randomUUID(),expectedVaultId:randomUUID(),title:'Wrong vault',type:'note',body:'Keep local'};
  await assert.rejects(f.service.save_page(request,f.context),/different vault/);
  assert.equal((await f.service.mutation({requestId:request.requestId},f.context)).receipt,null);
  assert.equal((await f.service.records({},f.context)).total,0);
});


test('sample retrieval also respects retired service lifecycle',async()=>{
  const services=[];
  const service=createKnowledgeService({pluginConfig:{},registerService:s=>services.push(s)});
  services[0].start(); services[0].stop();
  for (const operation of ['grep','lookup']) await assert.rejects(service[operation]({query:'fictional'},{}),/reloaded/);
});


test('status snapshot is stable for unchanged reads and detects equal-count edits and source corruption', async t => {
  const f = await fixture(t);
  const record = await f.service.save_page({requestId:randomUUID(),title:'Snapshot',type:'note',body:'Original',source:{text:'Retained source',attribution:'test'}},f.context);
  const before = await f.service.status({},f.context);
  assert.equal((await f.service.status({},f.context)).snapshot,before.snapshot);
  const changed = await f.service.save_page({requestId:randomUUID(),id:record.id,expectedRevision:record.revision,expectedHash:record.hash,title:'Snapshot',body:'Changed'},f.context);
  const after = await f.service.status({},f.context);
  assert.equal(after.records,before.records);
  assert.notEqual(after.snapshot,before.snapshot);
  const detail = await f.service.record({id:changed.id,includeMetadata:true},f.context);
  await writeFile(f.root+'/private/'+detail.record.metadata.evidence[0].path,'Corrupted source');
  assert.notEqual((await f.service.status({},f.context)).snapshot,after.snapshot);
});
