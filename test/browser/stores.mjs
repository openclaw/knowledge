// Rendered store settings check: viewing selector, assignment menus/dialogs
// and truthful outcomes against a real service. Run after TypeScript
// compilation: node test/browser/stores.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { createKnowledgeService } from '../../dist/service.js';
import { hostApi, toolContext, operatorContext } from '../support.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(await fs.realpath('node_modules/openclaw') + '/node_modules/playwright');
const base = await fs.realpath(await fs.mkdtemp('/tmp/knowledge-stores-browser-'));
const host = hostApi(base, { agents: ['main', 'research', 'ops'], policy: { operatorRead: true, writesEnabled: true } });
const service = createKnowledgeService(host.api, { emit: () => {} });
let scopes = ['operator.admin'];
for (const [agent, title] of [['main', 'Northwind launch'], ['main', 'Alex Rivera'], ['research', 'Literature review']]) {
  await service.save_page({ requestId: randomUUID(), title, type: 'project', body: `${title} notes.` }, toolContext(host.api, agent));
}
const entry = `import plugin from './src/control-ui.ts';
const listeners=new Set(), events=new Map();
const host={pluginId:'knowledge',signal:new AbortController().signal,connection:{connected:true},redact:String,
 request:async(method,p)=>{ try { return {ok:true,result:await window.invokeKnowledge(p.actionId,p.payload)}; } catch(e) { return {ok:false,error:String(e.message||e)}; } },
 onEvent:(name,fn)=>{events.set(name,fn);return()=>events.delete(name)},subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},
 agents:{rows:[{id:'main',name:'Main',identity:{name:'Atlas'}},{id:'research',name:'Research'},{id:'ops',name:'Ops'}],selectedId:'main'},
 sessions:{create:async()=>'x',open:()=>{}},
 ui:{registerNavigation:()=>()=>{},registerPage:view=>{view.mount(document.querySelector('main'),{host,signal:new AbortController().signal});return()=>{}}}};
plugin.activate(host);`;
const bundle = await build({ stdin: { contents: entry, resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife', loader: { '.css': 'empty' } });
const html = '<html><head><style>:root{--bg:#fff;--text:#18221b;--text-strong:#0b120d;--muted:#66736b;--border:#c7d2cc;--card:#f5f8f6;--bg-hover:#edf2ef;--accent:#247044;--danger:#a32d26;--accent-subtle:#e3f1e8}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui}' + await fs.readFile('src/control-ui.css', 'utf8') + '</style></head><body><main></main><script>' + bundle.outputFiles[0].text + '</script></body></html>';
const browser = await chromium.launch({ headless: true, args: ['--disable-gpu'], executablePath: process.env.KNOWLEDGE_BROWSER_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const errors = [], checks = [];
const requests = [];
async function open(width = 1280) {
  const page = await browser.newPage({ viewport: { width, height: 800 } }); page.setDefaultTimeout(10000);
  page.on('pageerror', e => errors.push(e.message));
  await page.exposeFunction('invokeKnowledge', async (op, input) => { requests.push(op); return service[op](input, operatorContext(host.api, scopes)); });
  await page.route('https://knowledge.test/**', r => r.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('https://knowledge.test/');
  await page.locator('.knowledge-store-context strong').waitFor();
  return page;
}
try {
  let page = await open();
  assert.equal(await page.locator('.knowledge-store-context strong').textContent(), 'Atlas’s knowledge');
  // Selecting an unprovisioned agent explains the store and creates nothing.
  await page.selectOption('.knowledge-agent-select select', 'ops');
  await page.getByText('Ops’s knowledge doesn’t exist yet').waitFor();
  assert.equal(await page.locator('.knowledge-search').count(), 0, 'No search against a store that is not ready');
  assert.deepEqual(await fs.readdir(host.stateRoot + '/stores').then(d => d.length), 2, 'Viewing never provisions');
  checks.push('unprovisioned view');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('.knowledge-assignments').waitFor();
  // The Change… menu renders fully inside the viewport, above the table.
  await page.getByRole('button', { name: 'Change store for Ops' }).click();
  const menu = page.locator('.knowledge-menu:popover-open');
  const box = await menu.boundingBox();
  assert.ok(box && box.y >= 0 && box.y + box.height <= 800 && box.x >= 0 && box.x + box.width <= 1280, 'Menu fully visible');
  assert.equal(await menu.evaluate(n => document.elementFromPoint(n.getBoundingClientRect().x + 10, n.getBoundingClientRect().bottom - 6)?.closest('.knowledge-menu') === n), true, 'Menu is not clipped');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Change store for Ops', 'Focus returns to the trigger');
  checks.push('menu visibility and focus');
  // Share: consequence preview, then one save; the store bar and table update.
  await page.getByRole('button', { name: 'Change store for Atlas' }).click();
  await page.locator('.knowledge-menu:popover-open').getByRole('menuitem', { name: /Share this store/ }).click();
  const dialog = page.locator('dialog.knowledge-store-dialog');
  assert.equal(await dialog.getByRole('button', { name: 'Share store' }).isDisabled(), true, 'Nothing to save yet');
  await dialog.locator('.knowledge-field input').fill('Personal');
  await dialog.locator('#share-research').check();
  await dialog.getByText('Research will switch from Research’s knowledge.', { exact: false }).waitFor();
  await dialog.getByRole('button', { name: 'Share store' }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.getByText('Shared with Research').first().waitFor();
  assert.deepEqual(host.host.config.plugins.entries.knowledge.config.stores, { personal: { label: 'Personal', agents: ['main', 'research'] } });
  checks.push('share flow');
  // A stale revision is a conflict: the dialog stays with its inputs and explains.
  host.host.config = structuredClone(host.host.config);
  host.host.config.plugins.entries.knowledge.config.stores.other = { agents: [] };
  await page.getByRole('button', { name: 'Change store for Ops' }).click();
  await page.locator('.knowledge-menu:popover-open').getByRole('menuitem', { name: /Use shared store/ }).click();
  await dialog.getByRole('button', { name: 'Use Personal' }).click();
  await dialog.getByText('Store settings changed', { exact: false }).waitFor();
  assert.equal(await dialog.isVisible(), true, 'Dialog kept after a conflict');
  await dialog.getByRole('button', { name: 'Use Personal' }).click();
  await dialog.waitFor({ state: 'detached' });
  checks.push('conflict then deliberate save');
  // Read-only operators see why changes are unavailable.
  scopes = ['operator.read'];
  page = await open(390);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('.knowledge-assignments').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Change store for Atlas' }).isDisabled(), true);
  await page.getByText('requires operator admin access').waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'No horizontal overflow when narrow');
  checks.push('read-only and narrow layout');
  assert.ok(!requests.some(op => ['save_page', 'create_claim', 'publish_batch', 'correct', 'withdraw'].includes(op)), 'Settings never edits knowledge');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, artifacts: base }, null, 2));
} finally { await browser.close(); }
