// Browser history/reload proof over the real Knowledge service in an isolated store.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { createKnowledgeService } from '../../dist/service.js';
import { hostApi, toolContext, operatorContext } from '../support.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(await fs.realpath('node_modules/openclaw') + '/node_modules/playwright');
const base = await fs.realpath(await fs.mkdtemp('/tmp/knowledge-location-browser-'));
const host = hostApi(base, { agents: ['main','research','ops'], policy: { operatorRead:true, writesEnabled:true } });
const lifecycles = [];
host.api.registerService = service => lifecycles.push(service);
const service = createKnowledgeService(host.api,{emit:()=>{}});
const records = {};
for (const [agent,title,type] of [['main','Northwind launch','project'],['main','Alex Rivera','person'],['research','Literature review','project']]) {
  records[title] = await service.save_page({requestId:randomUUID(),title,type,body:`${title} notes.`},toolContext(host.api,agent));
}
const entry = `import plugin from './src/control-ui.ts';
let handle, view; const signal=new AbortController().signal;
const props=()=>Object.fromEntries([...new URLSearchParams(location.search)].filter(([k])=>k.startsWith('p.')).map(([k,v])=>[k.slice(2),v]));
const context=()=>({host,signal,props:props()});
const host={pluginId:'knowledge',signal,connection:{connected:true},redact:String,
 request:async(method,p)=>{try{return{ok:true,result:await window.invokeKnowledge(p.actionId,p.payload)}}catch(e){return{ok:false,error:String(e.message||e)}}},
 onEvent:()=>()=>{},subscribe:()=>()=>{},agents:{rows:[{id:'main',name:'Main'},{id:'research',name:'Research'},{id:'ops',name:'Ops'}],selectedId:'main'},sessions:{create:async()=>'x',open:()=>{}},
 navigation:{openPage:({id,params},options)=>{const url=new URL('/plugin?plugin=knowledge&id='+id,location.origin);for(const[k,v]of Object.entries(params))url.searchParams.set('p.'+k,v);history[options?.replace?'replaceState':'pushState'](null,'',url);queueMicrotask(()=>handle?.update(context()));}},
 ui:{registerNavigation:()=>()=>{},registerPage:page=>{view=page;return()=>{}}}};
plugin.activate(host);handle=view.mount(document.querySelector('main'),context());
window.addEventListener('popstate',()=>handle.update(context()));`;
const bundle=await build({stdin:{contents:entry,resolveDir:process.cwd()},bundle:true,write:false,format:'iife',loader:{'.css':'empty'}});
const html='<main></main><script>'+bundle.outputFiles[0].text+'</script>';
const browser=await chromium.launch({headless:true,executablePath:process.env.KNOWLEDGE_BROWSER_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const errors=[],requests=[],checks=[];
let delayedRecord;
try {
  const page=await browser.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror',e=>errors.push(e.message));
  await page.exposeFunction('invokeKnowledge',async(op,input)=>{
    requests.push({op,input});
    if(op==='record' && delayedRecord && input.id===delayedRecord.id) { const pending=delayedRecord;delayedRecord=undefined;pending.started();await pending.gate; }
    return service[op](input,operatorContext(host.api,['operator.admin']));
  });
  await page.route('https://knowledge.test/**',r=>r.fulfill({contentType:'text/html',body:html}));
  await page.goto('https://knowledge.test/plugin?plugin=knowledge&id=overview');
  await page.locator('.knowledge-feed-item').first().waitFor();
  const mainVault=new URL(page.url()).searchParams.get('p.vault');assert.ok(mainVault);
  await page.getByRole('button',{name:'Browse',exact:true}).click();
  await page.getByRole('button',{name:'Northwind launch',exact:true}).click();
  const heading=title=>page.locator('.knowledge-entity-header h2').filter({hasText:title});
  await heading('Northwind launch').waitFor();
  const recordUrl=page.url();assert.equal(new URL(recordUrl).searchParams.get('p.record'),records['Northwind launch'].id);
  await page.reload();await heading('Northwind launch').waitFor();assert.equal(page.url(),recordUrl);
  checks.push('page URL, stable ID, store identity and reload');
  await page.getByRole('button',{name:'Browse',exact:true}).click();
  await page.getByRole('button',{name:'Alex Rivera',exact:true}).click();await heading('Alex Rivera').waitFor();
  await page.goBack();await page.locator('.knowledge-table').waitFor();
  await page.goBack();await heading('Northwind launch').waitFor();
  await page.goForward();await page.locator('.knowledge-table').waitFor();
  await page.goForward();await heading('Alex Rivera').waitFor();
  checks.push('back/forward restores pages without reload loops');
  await page.getByRole('button',{name:'Browse',exact:true}).click();
  await page.getByRole('searchbox',{name:'Filter by name or alias'}).fill('Northwind');
  await page.getByRole('searchbox',{name:'Filter by name or alias'}).press('Enter');
  await page.getByRole('button',{name:'Include history',exact:true}).click();
  await page.reload();await page.getByRole('button',{name:'Northwind launch',exact:true}).waitFor();
  assert.equal(await page.getByRole('searchbox',{name:'Filter by name or alias'}).inputValue(),'Northwind');
  assert.equal(await page.getByRole('button',{name:'Include history',exact:true}).getAttribute('aria-pressed'),'true');
  checks.push('browse filter and lifecycle survive reload');
  await page.getByRole('button',{name:'Recent',exact:true}).click();
  await page.getByRole('searchbox',{name:'Search knowledge'}).fill('Northwind');
  await page.getByRole('searchbox',{name:'Search knowledge'}).press('Enter');
  await page.locator('.knowledge-search-hit').waitFor();await page.reload();await page.locator('.knowledge-search-hit').waitFor();
  assert.equal(new URL(page.url()).searchParams.get('p.q'),'Northwind');
  checks.push('submitted search survives reload');
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.getByRole('button',{name:'Vault status',exact:true}).click();
  await page.reload();await page.getByRole('heading',{name:'Vault status',exact:true}).waitFor();
  checks.push('settings section survives reload');
  await page.goto(recordUrl);await heading('Northwind launch').waitFor();
  await page.selectOption('.knowledge-agent-select select','research');
  await page.getByText('Literature review',{exact:true}).first().waitFor();
  assert.equal(new URL(page.url()).searchParams.get('p.agent'),'research');
  assert.notEqual(new URL(page.url()).searchParams.get('p.vault'),mainVault);
  await page.reload();await page.getByText('Literature review',{exact:true}).first().waitFor();
  await page.goBack();await heading('Northwind launch').waitFor();
  checks.push('agent/store selection survives reload and back');
  const mismatch=new URL(recordUrl);mismatch.searchParams.set('p.vault','another-store');
  const start=requests.length;await page.goto(mismatch.href);
  await page.getByText('This link belongs to a different knowledge store',{exact:true}).waitFor();
  assert.ok(!requests.slice(start).some(r=>['record','records','grep','recent','connections'].includes(r.op)));
  assert.equal(page.url(),mismatch.href);
  checks.push('mismatched store never loads records or silently rewrites identity');
  const unknown=new URL(recordUrl);unknown.searchParams.set('p.agent','missing-agent');
  await page.goto(unknown.href);await page.getByText(/Unknown agent/).waitFor();
  assert.equal(await page.locator('.knowledge-entity-header').count(),0);
  checks.push('unknown agent never falls back to default store');
  await page.goto(recordUrl);await heading('Northwind launch').waitFor();
  await page.getByRole('button',{name:'Browse',exact:true}).click();await page.locator('.knowledge-table').waitFor();
  let release,started;const entered=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve);
  delayedRecord={id:records['Alex Rivera'].id,gate,started};
  await page.getByRole('button',{name:'Alex Rivera',exact:true}).click();await entered;
  await page.goBack();await page.locator('.knowledge-table').waitFor();release();
  await page.getByRole('button',{name:'Northwind launch',exact:true}).click();await heading('Northwind launch').waitFor();
  assert.equal(await page.locator('.knowledge-entity-header h2').textContent(),'Northwind launch');
  checks.push('late page response cannot overwrite browser history navigation');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({checks},null,2));
} finally { await browser.close();for (const lifecycle of lifecycles) await lifecycle.stop();await fs.rm(base,{recursive:true,force:true}); }
