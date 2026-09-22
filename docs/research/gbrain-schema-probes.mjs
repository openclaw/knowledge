// Research probes for upstream gbrain commit 7cdc3e30a898665a8c87b0c06937f6366f759f6c.
// Usage: bun docs/research/gbrain-schema-probes.mjs /path/to/gbrain
// The upstream root must resolve zod@4.3.6. No live brain or database is used.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
if (!process.argv[2]) throw new Error('Pass the upstream gbrain checkout/archive root');
const root=resolve(process.argv[2]);
const upstream=(path)=>import(pathToFileURL(resolve(root,path)).href);
const {parseSchemaPackManifest}=await upstream('src/core/schema-pack/manifest-v1.ts');
const {getPrimitiveDefaults}=await upstream('src/core/schema-pack/primitives.ts');
const {resolvePack, invalidatePackCache}=await upstream('src/core/schema-pack/registry.ts');
const {expandClosure}=await upstream('src/core/schema-pack/closure.ts');
const {expertTypesFromPack}=await upstream('src/core/schema-pack/expert-types.ts');
const {extractableTypesFromPack}=await upstream('src/core/schema-pack/extractable.ts');
const {isFactsBackstopEligible}=await upstream('src/core/facts/eligibility.ts');
const {loadPackFromFile}=await upstream('src/core/schema-pack/loader.ts');

let passed=0;
function check(name, fn) { fn(); passed++; console.log(`PASS ${name}`); }
const manifest=(name,extra={})=>parseSchemaPackManifest({api_version:'gbrain-schema-pack-v1',name,version:'1.0.0',extends:null,...extra});
const entity=manifest('entity-probe',{page_types:[{name:'researcher',primitive:'entity'}]});
check('entity primitive does not supply expert/extraction defaults to parsed type',()=>{
 assert.equal(getPrimitiveDefaults('entity').default_expert_routing,true);
 assert.equal(getPrimitiveDefaults('entity').default_extractable,true);
 assert.deepEqual(expertTypesFromPack(entity),[]);
 assert.equal(extractableTypesFromPack(entity).size,0);
});
const entityResolved=await resolvePack(entity,async()=>{throw Error('unexpected parent')});
check('resolution does not activate primitive defaults either',()=>assert.equal(entityResolved.manifest.page_types[0].expert_routing,false));
check('unknown primitive rejected',()=>assert.throws(()=>manifest('bad',{page_types:[{name:'x',primitive:'custom'}]})));
check('pack page type does not accept typed field declarations',()=>assert.throws(()=>manifest('fields',{page_types:[{name:'x',primitive:'temporal',fields:[{name:'date',type:'date'}]}]})));
const parent=manifest('parent-probe',{page_types:[{name:'person',primitive:'entity',path_prefixes:['people/'],expert_routing:true,extractable:true}],phases:['extract_atoms']});
const child=manifest('child-probe',{extends:parent.name,page_types:[{name:'person',primitive:'entity'},{name:'researcher',primitive:'entity',aliases:['person']},{name:'adversary',primitive:'entity'}]});
const resolved=await resolvePack(child,async()=>parent);
check('type override replaces whole definition, not individual fields',()=>{
 const person=resolved.manifest.page_types.find(t=>t.name==='person');
 assert.deepEqual(person.path_prefixes,[]);assert.equal(person.expert_routing,false);
});
check('parent phases not inherited',()=>assert.equal(resolved.manifest.phases,undefined));
check('aliases expand symmetrically but shared primitive does not',()=>{
 assert.deepEqual(expandClosure('person',resolved.alias_graph).sort(),['person','researcher']);
 assert.deepEqual(expandClosure('adversary',resolved.alias_graph),['adversary']);
});
const extract=manifest('extract-probe',{page_types:[{name:'research-note',primitive:'temporal',extractable:true}]});
check('pack-declared extraction eligibility does not change facts backstop allowlist',()=>{
 assert.equal(extractableTypesFromPack(extract).has('research-note'),true);
 assert.deepEqual(isFactsBackstopEligible('research/example',{type:'research-note',compiled_truth:'x'.repeat(100),frontmatter:{}}),{ok:false,reason:'kind:research-note'});
});
const inheritedChild=manifest('inherited-probe',{extends:parent.name});
const first=await resolvePack(inheritedChild,async()=>parent);
invalidatePackCache();
const second=await resolvePack(inheritedChild,async()=>({...parent,page_types:[...parent.page_types,{...entity.page_types[0]}]}));
check('leaf identity alone does not fingerprint inherited effective schema',()=>{
 assert.equal(first.identity,second.identity);assert.notDeepEqual(first.manifest,second.manifest);
});
const base=loadPackFromFile(resolve(root,'src/core/schema-pack/base/gbrain-base-v2.yaml'));
console.log('BASE_V2_TYPES',base.page_types.length,base.page_types.map(t=>`${t.name}:${t.primitive}`).join(', '));
console.log(`${passed} focused behavioral probes passed`);
