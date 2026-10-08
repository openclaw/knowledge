// Real browser and Knowledge service; synthetic records stay in an isolated store.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { createKnowledgeService } from '../../dist/service.js';
import { hostApi, toolContext, operatorContext } from '../support.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(await fs.realpath('node_modules/openclaw') + '/node_modules/playwright');
const base = await fs.realpath(await fs.mkdtemp('/tmp/knowledge-large-record-'));
const host = hostApi(base, { agents: ['main'], policy: { operatorRead: true, writesEnabled: true } });
const lifecycles = [];
host.api.registerService = service => lifecycles.push(service);
const service = createKnowledgeService(host.api, { emit: () => {} });
const source = 'Opening paragraph.\n\n<!-- internal ' + 'private-marker '.repeat(6000) + '-->\n\n```text\n' + 'code line\n'.repeat(3000) + '[literal](https://example.invalid/)\n```\n\nEnd marker.';
let saved = await service.save_page({requestId:randomUUID(),title:'Large record fixture',type:'note',body:source.slice(0,40000)},toolContext(host.api));
const status = await service.status({}, toolContext(host.api));
for (let offset=40000;offset<source.length;offset+=40000) {
  saved = await service.edit_body({requestId:randomUUID(),id:saved.id,expectedVaultId:status.vault,expectedRevision:saved.revision,
    expectedHash:saved.hash,expectedOntologyFingerprint:status.ontologyFingerprint,start:offset,end:offset,
    replacement:source.slice(offset,offset+40000),reason:'Synthetic bounded browser fixture'},toolContext(host.api));
}
const entry = "import plugin from './src/control-ui.ts';\nconst signal=new AbortController().signal;\nconst host={pluginId:'knowledge',signal,connection:{connected:true},redact:String,\n request:async(method,p)=>({ok:true,result:await window.invokeKnowledge(p.actionId,p.payload)}),\n onEvent:()=>()=>{},subscribe:()=>()=>{},agents:{rows:[{id:'main',name:'Main'}],selectedId:'main'},\n sessions:{create:async()=>'x',open:()=>{}},navigation:{openPage:()=>{}},\n ui:{registerNavigation:()=>()=>{},registerPage:view=>{view.mount(document.querySelector('main'),{host,signal,props:{record:new URL(location.href).searchParams.get('record')}});return()=>{}}}};\nplugin.activate(host);";
const bundle = await build({ stdin: { contents: entry, resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife', loader: { '.css': 'empty' } });
const css = ':root{--bg:#fff;--text:#18221b;--muted:#66736b;--border:#c7d2cc;--card:#f5f8f6;--accent:#247044;--font-body:system-ui}*{box-sizing:border-box}body{margin:0}' + await fs.readFile('src/control-ui.css','utf8');
const html = '<style>' + css + '</style><main></main><script>' + bundle.outputFiles[0].text + '</script>';
const browser = await chromium.launch({headless:true, executablePath:process.env.KNOWLEDGE_BROWSER_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const errors = [];
try {
  const page = await browser.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', e => errors.push(e.message));
  await page.exposeFunction('invokeKnowledge', (op, input) => {
    assert.ok(!['edit_body','save_page','annotate','reconcile_evidence','correct','withdraw'].includes(op));
    return service[op](input, operatorContext(host.api, ['operator.admin']));
  });
  await page.route('https://knowledge.test/**', route => route.fulfill({contentType:'text/html',body:html}));
  // Comments span transport windows; every intermediate rendering must hide them.
  for (const width of [1280,390]) {
    await page.setViewportSize({width,height:900});
    await page.goto('https://knowledge.test/?record=' + saved.id);
    await page.getByRole('button',{name:'Read more notes',exact:true}).waitFor();
    const disclosure=page.locator('.knowledge-notes-toggle summary');
    if(await disclosure.count()) await disclosure.click();
    let pages=0;
    while(await page.getByRole('button',{name:'Read more notes',exact:true}).count()) {
      const more=page.getByRole('button',{name:'Read more notes',exact:true});
      await more.click();
      await page.waitForFunction(()=>!document.querySelector('.knowledge-summary button:disabled'));
      assert.doesNotMatch(await page.locator('.knowledge-summary').innerText(),/private-marker|<!--/);
      assert.ok(++pages<10,'bounded continuation reaches the end');
    }
    assert.ok(pages>=2);
    assert.match(await page.locator('.knowledge-summary').innerText(),/End marker/);
    assert.equal(await page.locator('.knowledge-summary a[href="https://example.invalid/"]').count(),0);
    assert.match(await page.locator('.knowledge-summary pre').innerText(),/\[literal\]/);
    assert.doesNotMatch(await page.locator('.knowledge-summary').innerText(),/Showing part of this record/);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:base+'/notes-'+width+'.png',fullPage:true});
  }
  const current=(await service.record({id:saved.id,view:'summary'},toolContext(host.api))).record;
  assert.equal(current.hash,saved.hash);assert.equal(current.revision,saved.revision);
  // A changed record must not append text from a different revision.
  await page.goto('https://knowledge.test/?record='+saved.id);
  await page.getByRole('button',{name:'Read more notes',exact:true}).waitFor();
  const disclosure=page.locator('.knowledge-notes-toggle summary');if(await disclosure.count())await disclosure.click();
  await service.edit_body({requestId:randomUUID(),id:saved.id,expectedVaultId:status.vault,expectedRevision:saved.revision,
    expectedHash:saved.hash,expectedOntologyFingerprint:status.ontologyFingerprint,start:0,end:0,
    replacement:'New revision.\n',reason:'Synthetic stale-read test'},toolContext(host.api));
  await page.getByRole('button',{name:'Read more notes',exact:true}).click();
  await page.getByText('Record changed; reopen it before reading more notes.',{exact:true}).waitFor();
  assert.doesNotMatch(await page.locator('.knowledge-summary .knowledge-markdown').innerText(),/New revision/);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({passed:'bounded notes continuation, cross-window hidden comments, unchanged readback, stale revision rejection, desktop/mobile',artifacts:base}));
} finally { await browser.close(); for (const lifecycle of lifecycles) await lifecycle.stop(); }
