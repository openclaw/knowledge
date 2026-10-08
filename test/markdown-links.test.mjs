import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdown, extractLinks, resolveLinks, wikiHref } from '../dist/markdown-links.js';
import { connections } from '../dist/connections.js';
import { recordPath } from '../dist/record-path.js';
const record = (id, title, path, body='', extra={}) => ({id,title,path,body,raw:body,hash:body,kind:'page',type:'person',valid:true,lifecycle:'active',revision:1,metadata:{aliases:[],lifecycle:'active',...extra}});

test('Markdown tokenization excludes code, escapes, HTML, images and generated backlinks', () => {
  const body = '[Alex](../people/alex.md) [[Alex|A]]\n\n`[[Code]]`\n\n```md\n[[Fence]]\n```\n\n    [[Indent]]\n\n\\[[Escape]]\n\n<a href="people/html.md">HTML</a> ![image](people/image.md)\n\n<!-- backlinks:start -->\n[[Generated]]\n<!-- backlinks:end -->\n\n[ref][person]\n\n[person]: people/alex.md';
  assert.deepEqual(extractLinks(body), ['../people/alex.md',wikiHref('Alex'),'people/alex.md']);
});
test('comments are invisible while code examples and other HTML stay escaped', () => {
  const source = 'Before <!-- project: path:/private/workspace --> after\n\n<!-- hidden\n[[Secret]]\n-->\n\n`<!-- inline example -->`\n\n```html\n<!-- fenced example -->\n```\n\n&lt;!-- escaped example --&gt;\n\n<script>unsafe()</script>';
  const rendered = markdown.parse(source);
  assert.doesNotMatch(rendered, /private\/workspace|hidden|Secret/);
  assert.match(rendered, /Before  after/);
  assert.match(rendered, /&lt;!-- inline example --&gt;/);
  assert.match(rendered, /&lt;!-- fenced example --&gt;/);
  assert.match(rendered, /&lt;!-- escaped example --&gt;/);
  assert.match(rendered, /&lt;script&gt;unsafe/);
  assert.deepEqual(extractLinks(source), []);
});

test('backlink markers inside code do not suppress subsequent authored links', () => {
  assert.deepEqual(extractLinks('```html\n<!-- backlinks:start -->\n```\n\n[[Alex]]'),[wikiHref('Alex')]);
});
test('current path, title, alias and old ID paths resolve; ambiguity never chooses an arbitrary target', () => {
  const alex=record('a','Alex Rivera','people/alex-rivera.md','',{aliases:['Alex']}), other=record('b','Blair','people/blair.md');
  const source=record('s','Meeting','meetings/team.md','[[Alex]] [[people/alex-rivera#Notes|Alex]] [old](../people/a.md) [new](../people/alex-rivera.md) [[Missing]]');
  assert.deepEqual(resolveLinks(source,[alex,other,source]).map(l=>l.id??l.status),['a','a','a','a','missing']);
  other.metadata.aliases=['Alex'];
  assert.equal(resolveLinks(source,[alex,other])[0].status,'ambiguous');
  assert.equal(resolveLinks(source,[other])[1].status,'missing');
  alex.path='people/renamed.md'; assert.equal(resolveLinks(source,[alex])[2].id,'a');
});
test('derived backlinks deduplicate passages, reflect edits, exclude unavailable records and do not replace relationships', () => {
  const a=record('a','Alex','people/alex.md'), s=record('s','Meeting','meetings/team.md','[[Alex]] [[Alex#Note]] [Alex](../people/alex.md)');
  const edge={...record('edge','Works with','relationships/works.md'),kind:'relationship',metadata:{lifecycle:'active',from:'a',to:'s',label:'works_with'}};
  const hidden=record('h','Hidden','people/hidden.md','[[Alex]]',{record_class:'fixture'});
  const data={records:[a,s,edge,hidden],issues:[]};
  const c=connections(data,{id:'a'}); assert.equal(c.connections.filter(r=>r.direction==='backlinks').length,1);assert.equal(c.connections.filter(r=>r.direction==='outgoing').length,1);
  assert.equal(connections(data,{id:'s',direction:'links'}).connections[0].record.id,'a');
  assert.equal(connections(data,{id:'a'},new Set(['s'])).total,0);
  s.body='No longer linked.';assert.equal(connections(data,{id:'a',direction:'backlinks'}).total,0);assert.equal(connections(data,{id:'a',direction:'outgoing'}).total,1);
});
test('unsafe or external destinations never resolve as local records', () => {
  const a=record('a','Alex','people/alex.md');
  const s=record('s','Meeting','meetings/team.md','[web](https://example.com/a.md) [file](file:///a.md) [[javascript:alert(1)]] [[../outside]] [bad](%ZZ.md)');
  const links=resolveLinks(s,[a]);assert.equal(links.length,3);assert.ok(links.every(l=>l.status==='missing'));
});
test('descriptive filenames are safe, Unicode-aware and collision preserving', () => {
  assert.equal(recordPath('people/','Josh Lehman','12345678-aaaa',()=>false),'people/josh-lehman.md');
  assert.equal(recordPath('claims/','Ship the release!','12345678-aaaa',p=>p==='claims/ship-the-release.md'),'claims/ship-the-release-12345678.md');
  assert.equal(recordPath('people/','../A / B','12345678',()=>false),'people/a-b.md');
  assert.ok(!recordPath('people/','東京','12345678',()=>false).includes('untitled'));
});

test('real scans expose scoped link resolutions and diagnostics without invalidating authored pages; renames rebuild navigation', async t => {
  const {cp,mkdtemp,readFile,writeFile,rename,rm}=await import('node:fs/promises');
  const {SampleVault,SAMPLE_ROOT}=await import('../dist/vault.js');
  const {inspectRecord}=await import('../dist/inspection.js');
  const root=await mkdtemp('/tmp/knowledge-links-');t.after(()=>rm(root,{recursive:true,force:true}));
  await cp(SAMPLE_ROOT,root,{recursive:true});
  const file=root+'/people/alex-rivera.md';
  const before=await readFile(file,'utf8');
  await writeFile(file,before+'\n[[Missing page]] [self](alex-rivera.md)\n');
  const vault=new SampleVault(root), detail=await inspectRecord(vault,{id:'sample_person_alex'});
  assert.ok(detail.record.valid);assert.ok(detail.links.some(l=>l.status==='missing'));
  assert.ok(detail.issues.some(i=>i.code==='missing-link'));
  assert.ok(detail.links.some(l=>l.id==='sample_person_alex'));
  await rename(file,root+'/people/alex-renamed.md');
  const changed=await inspectRecord(vault,{id:'sample_person_alex'});
  assert.equal(changed.record.path,'people/alex-renamed.md');
  assert.equal(changed.links.find(l=>l.href==='alex-rivera.md').status,'missing');
});
