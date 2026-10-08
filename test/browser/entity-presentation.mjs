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
const base = await fs.realpath(await fs.mkdtemp('/tmp/knowledge-entity-presentation-'));
const host = hostApi(base, { agents: ['main'], policy: { operatorRead: true, writesEnabled: true } });
const lifecycles = [];
host.api.registerService = service => lifecycles.push(service);
const service = createKnowledgeService(host.api, { emit: () => {} });
const fixtures = [];
// Cover a resolved person with a role and a partial identity without one.
for (const [title, status, role] of [['Alex Rivera', 'resolved', 'Launch lead'], ['kestrel', 'partial', undefined]]) {
  const body = title + ' participates. <!-- project: path:/private/workspace -->';
  const saved = await service.save_page({ requestId: randomUUID(), title, type: 'person', body,
    identity: { status, context: 'Coordinates launch operations.' }, ...(role ? { fields: { role } } : {}) }, toolContext(host.api));
  fixtures.push({ ...saved, title, body, status, role });
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
    assert.ok(!['save_page','annotate','reconcile_evidence','correct','withdraw'].includes(op));
    return service[op](input, operatorContext(host.api, ['operator.admin']));
  });
  await page.route('https://knowledge.test/**', route => route.fulfill({contentType:'text/html',body:html}));
  // Rendering must preserve source bytes and identity distinctions at both sizes.
  for (const fixture of fixtures) {
    await page.goto('https://knowledge.test/?record=' + fixture.id);
    await page.locator('.knowledge-entity-header h2').filter({hasText:fixture.title}).waitFor();
    for (const width of [1280,390]) {
      await page.setViewportSize({width,height:900});
      const header = await page.locator('.knowledge-entity-header').innerText();
      assert.equal(header.split('Coordinates launch operations.').length - 1, 1);
      assert.doesNotMatch(header, /is how the source describes|recorded as a role or employer/);
      if (fixture.role) assert.match(header, /Role: Launch lead/);
      else assert.doesNotMatch(header, /Role:/);
      if (fixture.status === 'partial') assert.match(header, /Identity unresolved/);
      assert.equal((await page.locator('.knowledge-markdown').innerText()).trim(), fixture.title + ' participates.');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({path:base + '/' + fixture.status + '-' + width + '.png',fullPage:true});
    }
    const saved = (await service.record({id:fixture.id},toolContext(host.api))).record;
    assert.equal(saved.body, fixture.body);
    assert.equal(saved.hash, fixture.hash);
    assert.equal(saved.revision, fixture.revision);
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({passed:'single identity context, no disclaimer, role and uncertainty preserved, hidden comments, unchanged records, desktop/mobile',artifacts:base}));
} finally { await browser.close(); for (const lifecycle of lifecycles) await lifecycle.stop(); }

