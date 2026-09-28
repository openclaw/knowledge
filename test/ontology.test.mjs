import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cp, mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {stringify} from 'yaml';
import {Check} from 'typebox/value';
import {SampleVault,SAMPLE_ROOT,digest} from '../dist/vault.js';
import {parseOntology,resolveOntology,expandTypes,inferType} from '../dist/ontology.js';
import { inspectRecord, inspectOntology } from "../dist/inspection.js";
import {contract} from '../dist/contract.js';
const manifest=(name,definitions=[],extra={})=>({format:'knowledge-ontology-v1',name,version:'1.0.0',description:'Test ontology',definitions,...extra});
const page=(name,extra={})=>({name,label:name,description:'Test page type',kind:'page',primitive:'entity',directory:`${name}/`,fields:[],...extra});
const relation=(name,extra={})=>({name,label:name,description:'Test relationship',kind:'relationship',directory:'relationships/',fields:[],...extra});
function resolve(...manifests) {
  const issues=[];
  const sources=manifests.map((m,i)=>parseOntology(i===manifests.length-1?'ontology.yaml':`ontologies/${m.name}.yaml`,stringify(m),issues));
  return {ontology:resolveOntology(sources,issues),issues,sources};
}
async function fixture(t) {
  const root=await mkdtemp(path.join(os.tmpdir(),'knowledge-ontology-'));
  await cp(SAMPLE_ROOT,root,{recursive:true});
  await mkdir(path.join(root,"notes"),{recursive:true});
  t.after(()=>rm(root,{recursive:true,force:true}));
  return {root,vault:new SampleVault(root)};
}
async function hashes(root) {
  const out={};
  for(const e of await readdir(root,{recursive:true,withFileTypes:true})) if(e.isFile()) {const p=path.join(e.parentPath,e.name);out[path.relative(root,p)]=digest(await readFile(p,'utf8'));}
  return out;
}
const sourceWrite=(root,file,value)=>writeFile(path.join(root,file),stringify(value));

test('custom local extension participates in inspection, aliases, filing, fields, and endpoint validation without code changes',async t=>{
  const {root,vault}=await fixture(t);
  const researcher=page('researcher',{directory:'researchers/',aliases:['person'],fields:[{name:'specialty',label:'Specialty',type:'string',required:true,values:['ecology','history']}]});
  const advises=relation('advises',{from_types:['researcher'],to_types:['project']});
  await sourceWrite(root,'ontology.yaml',manifest('research',[researcher,advises],{extends:'knowledge-default'}));
  await mkdir(path.join(root,'researchers'));
  const original=await readFile(path.join(root,'people/alex-rivera.md'),'utf8');
  const record=original.replace('sample_person_alex','sample_researcher_one').replace('type: person','type: researcher').replace('fields:\n','fields:\n  specialty: ecology\n');
  await writeFile(path.join(root,'researchers/researcher.md'),record);
  const edge=(await readFile(path.join(root,'relationships/alex-leads-garden.md'),'utf8')).replaceAll('sample_person_alex','sample_researcher_one').replace('sample_rel_leads','sample_rel_advises').replace('label: leads','label: advises');
  await writeFile(path.join(root,'relationships/advises.md'),edge);
  const before=await hashes(root), data=await vault.scan(), report=await vault.inspectOntology();
  assert.deepEqual(data.issues,[]);
  assert.equal(report.available,true);assert.equal(Check(contract.operations.ontology.output,await inspectOntology(vault, {})),true);
  const custom=report.definitions.find(d=>d.name==='researcher');
  assert.equal(custom.source,'ontology.yaml');assert.equal(custom.affectedRecords.length,1);
  assert.equal(custom.description,researcher.description);assert.deepEqual(custom.fields,researcher.fields);
  assert.deepEqual(report.definitions.find(d=>d.name==='advises').fromTypes,['researcher']);
  assert.deepEqual(report.definitions.find(d=>d.name==='advises').toTypes,['project']);
  assert.equal(JSON.parse(custom.effective).behaviors.extractable,false);
  assert.equal((await vault.list({type:'person'})).total,2);
  assert.equal((await vault.list({type:'researcher'})).total,2); // symmetric, not subtyping
  assert.equal((await vault.list({type:'organization'})).records[0].type,'company');
  assert.equal((await vault.list({type:'advises'})).total,1);
  assert.deepEqual(await hashes(root),before);
  await writeFile(path.join(root,'researchers/researcher.md'),record.replace('specialty: ecology','specialty: 42'));
  assert.ok((await vault.scan()).issues.some(i=>i.code==='field-type'));
  await writeFile(path.join(root,'researchers/researcher.md'),record.replace('  specialty: ecology\n',''));
  assert.ok((await vault.scan()).issues.some(i=>i.code==='required-field'));
  await writeFile(path.join(root,'researchers/researcher.md'),record.replace('specialty: ecology','specialty: music'));
  assert.ok((await vault.scan()).issues.some(i=>i.code==='field-type'));
  await writeFile(path.join(root,'researchers/researcher.md'),record);
  await writeFile(path.join(root,'relationships/advises.md'),edge.replace('from: sample_researcher_one','from: sample_person_alex'));
  assert.ok((await vault.scan()).issues.some(i=>i.path==='relationships/advises.md'&&i.code==='endpoint-type')); // aliases don't loosen validation
  await writeFile(path.join(root,'notes/misfiled.md'),record.replace('sample_researcher_one','sample_researcher_two'));
  assert.ok((await vault.scan()).issues.some(i=>i.path==='notes/misfiled.md'&&i.code==='filing'));
});

test('default source type exposes optional canonical and snapshot provenance fields', async t => {
  const { vault } = await fixture(t);
  const report = await vault.inspectOntology();
  const source = report.definitions.find(definition => definition.name === 'source');
  assert.deepEqual(source.fields.map(field => field.name), [
    'source_role', 'provider', 'source_key', 'coverage_start', 'coverage_end',
    'observed_at', 'source_revision', 'manifest_sha256', 'item_count',
    'completeness', 'watermark',
  ]);
  assert.deepEqual(source.fields.find(field => field.name === 'source_role').values, ['canonical', 'snapshot']);
  assert.deepEqual(source.fields.find(field => field.name === 'completeness').values, ['complete', 'partial', 'unknown']);
  assert.ok(source.fields.every(field => field.required === false));
});

test('whole-definition overrides, nearest-first path precedence, and root positions match gbrain composition',()=>{
  const base=manifest('base',[page('person',{directory:'people/',behaviors:{extractable:true,expert_routing:true},fields:[{name:'role',label:'Role',type:'string',required:true}]}),page('note',{primitive:'concept',directory:'notes/'})]);
  const parent=manifest('parent',[page('researcher',{directory:'notes/'}),page('person',{directory:'persons/'})],{extends:'base'});
  const leaf=manifest('leaf',[page('thesis',{directory:'notes/'}),page('person',{directory:'people/'})],{extends:'parent'});
  const {ontology:o,issues}=resolve(base,parent,leaf);assert.deepEqual(issues,[]);
  assert.deepEqual(o.definitions.map(d=>d.definition.name),['thesis','researcher','person','note']);
  assert.equal(inferType(o,'notes/a.md'),'thesis');
  const person=o.definitions.find(d=>d.definition.name==='person');assert.deepEqual(person.definition.fields,[]);assert.equal(person.definition.behaviors.expert_routing,false);assert.equal(person.ontology,'leaf');
});

test('selective borrowing is child-local, whole-definition, below child and above parents',()=>{
  const base=manifest('base',[page('person'),page('note',{primitive:'concept'})]);
  const donor=manifest('donor',[page('person',{directory:'borrowed/'}),page('scientist'),relation('mentors')],{extends:'base'});
  const borrow=[{ontology:'donor',types:['scientist','person'],relationships:['mentors']}];
  let {ontology:o,issues}=resolve(base,donor,manifest('leaf',[],{extends:'base',borrow_from:borrow}));
  assert.deepEqual(issues,[]);assert.equal(o.definitions.find(d=>d.definition.name==='person').ontology,'donor');assert.ok(o.definitions.some(d=>d.definition.name==='mentors'));
  o=resolve(base,donor,manifest('leaf',[page('person')],{extends:'base',borrow_from:borrow})).ontology;
  assert.equal(o.definitions.find(d=>d.definition.name==='person').ontology,'leaf');
  assert.equal(resolve(base,donor,manifest('leaf',[],{extends:'base',borrow_from:[{ontology:'donor',types:['note']}]})).ontology,null);
  const parent=manifest('parent',[],{extends:'base',borrow_from:borrow});
  o=resolve(base,donor,parent,manifest('leaf',[],{extends:'parent'})).ontology;
  assert.equal(o.definitions.some(d=>d.definition.name==='scientist'),false);
  o=resolve(donor,manifest('standalone',[page('person')],{borrow_from:borrow})).ontology;
  assert.equal(o.definitions.find(d=>d.definition.name==='person').ontology,'standalone');
});

test('alias closure is transitive and cyclic-safe, not primitive subtyping',()=>{
  const {ontology:o}=resolve(manifest('leaf',[page('person',{aliases:['researcher']}),page('researcher',{aliases:['scientist']}),page('scientist',{aliases:['person']}),page('company')]));
  assert.deepEqual([...expandTypes(o,'scientist')].sort(),['person','researcher','scientist']);
  assert.deepEqual([...expandTypes(o,'company')],['company']);
});

test('effective fingerprint changes for inherited/borrowed edits, not YAML key order or comments',async t=>{
  const {root,vault}=await fixture(t);await mkdir(path.join(root,'ontologies'));
  const parent=manifest('parent',[page('researcher')],{extends:'knowledge-default'});
  await sourceWrite(root,'ontologies/parent.yaml',parent);
  await sourceWrite(root,'ontology.yaml',manifest('local',[],{extends:'parent'}));
  const first=(await vault.scan()).ontology.fingerprint;
  parent.definitions[0].fields=[{name:'role',label:'Role',type:'string'}];
  await sourceWrite(root,'ontologies/parent.yaml',parent);
  const second=(await vault.scan()).ontology.fingerprint;assert.notEqual(first,second);
  await writeFile(path.join(root,'ontologies/parent.yaml'),'# comment\n'+stringify(Object.fromEntries(Object.entries(parent).reverse())));
  assert.equal((await vault.scan()).ontology.fingerprint,second);
  await sourceWrite(root,'ontology.yaml',manifest('local',[],{extends:'knowledge-default',borrow_from:[{ontology:'parent',types:['researcher']}]}));
  const third=(await vault.scan()).ontology.fingerprint;
  parent.definitions[0].directory='changed/';await sourceWrite(root,'ontologies/parent.yaml',parent);
  assert.notEqual((await vault.scan()).ontology.fingerprint,third);
});

test('invalid active ontology is inspectable, blocks dependent validation, and never changes files',async t=>{
  const {root,vault}=await fixture(t);
  for(const raw of ['format: [invalid\n',stringify(manifest('local',[],{extends:'missing'})),stringify(manifest('local',[],{phases:['extract_atoms']})),stringify(manifest('local',[relation('bad',{from_types:['missing']})]))]) {
    await writeFile(path.join(root,'ontology.yaml'),raw);const before=await hashes(root);
    const data=await vault.scan(),report=await vault.inspectOntology();
    assert.equal(data.ontology,null);assert.equal(report.available,false);assert.equal(report.definitions.length,0);
    assert.equal(report.affectedRecords.length,6);assert.ok(report.issues.some(i=>i.code==='ontology-unavailable'));
    assert.equal(report.sources.find(s=>s.path==='ontology.yaml').raw,raw);
    assert.equal(Check(contract.operations.ontology.output,await inspectOntology(vault, {})),true);assert.deepEqual(await hashes(root),before);
    assert.ok((await vault.detail('sample_person_alex')).record);
  }
});

test('cycles, missing parents, duplicate identities, cross-kind overrides and depth overflow fail closed',()=>{
  assert.equal(resolve(manifest('a',[],{extends:'b'}),manifest('b',[],{extends:'a'})).ontology,null);
  assert.equal(resolve(manifest('a',[],{extends:'missing'})).ontology,null);
  assert.equal(resolve(manifest('same'),manifest('same')).ontology,null);
  assert.equal(resolve(manifest('base',[page('person')]),manifest('child',[relation('person')],{extends:'base'})).ontology,null);
  const chain=Array.from({length:9},(_,i)=>manifest(`layer-${i}`,[],i?{extends:`layer-${i-1}`} : {}));
  assert.equal(resolve(...chain).ontology,null);assert.notEqual(resolve(...chain.slice(0,8)).ontology,null);
});

test('invalid primitives, fields, duplicate definitions and unsupported features are rejected before activation',()=>{
  for(const d of [page('x',{primitive:'unknown'}),page('x',{from_types:['person']}),relation('x',{aliases:['y']}),page('x',{fields:[{name:'x',label:'x',type:'number',values:['1']}]}),page('x',{fields:[{name:'x',label:'x',type:'string',values:[]}]})]) assert.equal(resolve(manifest('local',[d])).ontology,null);
  assert.equal(resolve(manifest('local',[page('x'),page('x')])).ontology,null);
  assert.equal(resolve(manifest('local',[],{remote:'https://example.org/ontology.yaml'})).ontology,null);
});

test('path inference never overwrites explicit type or original metadata',async t=>{
  const {root,vault}=await fixture(t);
  const file=path.join(root,'people/alex-rivera.md'),raw=await readFile(file,'utf8');
  await writeFile(file,raw.replace('type: person\n',''));let r=await vault.detail('sample_person_alex');
  assert.equal(r.record.type,'person');assert.equal(JSON.parse(r.record.metadata).type,undefined);
  await writeFile(file,raw.replace('type: person','type: note'));r=await vault.detail('sample_person_alex');
  assert.equal(r.record.type,'note');assert.ok(r.issues.some(i=>i.code==='filing'));
});

test('unsafe active ontology cannot silently fall back; legacy schemas are explicitly rejected',async t=>{
  const {root,vault}=await fixture(t);
  await symlink('/etc/passwd',path.join(root,'ontology.yaml'));
  assert.equal((await vault.scan()).ontology,null);
  await cp(new URL('./fixtures/legacy-schemas/',import.meta.url),path.join(root,'schemas'),{recursive:true});
  assert.ok((await vault.scan()).issues.some(i=>i.code==='unsupported-schema'));
});


test('unrestricted relationships still require endpoints with declared page types',async t=>{
  const {root,vault}=await fixture(t);
  const person=path.join(root,'people/alex-rivera.md');
  await writeFile(person,(await readFile(person,'utf8')).replace('type: person','type: unknown'));
  const edge=path.join(root,'relationships/alex-leads-garden.md');
  await writeFile(edge,(await readFile(edge,'utf8')).replace('label: leads','label: relates_to'));
  assert.ok((await vault.scan()).issues.some(i=>i.path==='relationships/alex-leads-garden.md'&&i.code==='endpoint-type'));
});

test('an active ontology directory is invalid, not an absent selection',async t=>{
  const {root,vault}=await fixture(t);
  await mkdir(path.join(root,'ontology.yaml'));
  assert.equal((await vault.scan()).ontology,null);
});


test('valid compact manifests remain inspectable after effective-definition formatting',async t=>{
  const {root,vault}=await fixture(t);
  const fields=Array.from({length:50},(_,i)=>({name:`field_${i}`,label:'Field',type:'string',values:Array(100).fill('x')}));
  const raw=JSON.stringify(manifest('local',[page('dense',{fields})],{extends:'knowledge-default'}));
  assert.ok(Buffer.byteLength(raw)<65536);
  await writeFile(path.join(root,'ontology.yaml'),raw);
  const report=await vault.inspectOntology();assert.equal(report.available,true);
  assert.equal(Check(contract.operations.ontology.output,await inspectOntology(vault, {})),true);
});
