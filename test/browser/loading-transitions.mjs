// Real service + held responses prove loading boundaries, not just final screenshots.
// KNOWLEDGE_BROWSER_PATH=/path/to/chrome node test/browser/loading-transitions.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { createKnowledgeService } from '../../dist/service.js';
import { hostApi, toolContext, operatorContext } from '../support.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(await fs.realpath('node_modules/openclaw') + '/node_modules/playwright');
const base = await fs.realpath(await fs.mkdtemp('/tmp/knowledge-loading-'));
const host = hostApi(base, { agents: ['main', 'other'], policy: { operatorRead: true, writesEnabled: true } });
const lifecycles = [];
host.api.registerService = lifecycle => lifecycles.push(lifecycle);
const service = createKnowledgeService(host.api, { emit: () => {} });
const project = await service.save_page({ requestId: randomUUID(), title: 'Northwind launch', type: 'project', body: 'Readable project body.' }, toolContext(host.api));
await service.save_page({ requestId: randomUUID(), title: 'Alex Rivera', type: 'person', body: 'Launch owner.' }, toolContext(host.api));
await service.save_page({ requestId: randomUUID(), title: 'Other private project', type: 'project', body: 'Other store only.' }, toolContext(host.api, 'other'));
const entry = `import plugin from './src/control-ui.ts';
let handle, view; const signal = new AbortController().signal;
const props = () => Object.fromEntries([...new URLSearchParams(location.search)].filter(([k]) => k.startsWith('p.')).map(([k,v]) => [k.slice(2),v]));
const context = () => ({host, signal, props: props()});
const host = {pluginId:'knowledge', signal, connection:{connected:true}, redact:String,
 request:async(method,p)=>{try{return {ok:true,result:await window.invokeKnowledge(p.actionId,p.payload)}}catch(e){return {ok:false,error:e.message}}finally{setTimeout(()=>window.settledRequests.push({op:p.actionId,kind:p.payload?.kind}),0)}},
 onEvent:()=>()=>{}, subscribe:()=>()=>{}, agents:{rows:[{id:'main',name:'Main'},{id:'other',name:'Other'}],selectedId:'main'}, sessions:{create:async()=>'x',open:()=>{}},
 navigation:{openPage:({id,params},options)=>{const url=new URL('/plugin?plugin=knowledge&id='+id,location.origin);for(const[k,v]of Object.entries(params))url.searchParams.set('p.'+k,v);history[options?.replace?'replaceState':'pushState'](null,'',url);queueMicrotask(()=>handle?.update(context()));}},
 ui:{registerNavigation:()=>()=>{},registerPage:page=>{view=page;return()=>{}}}};
window.settledRequests=[];plugin.activate(host);handle=view.mount(document.querySelector('main'),context());
window.addEventListener('popstate',()=>handle.update(context()));`;
const bundle = await build({ stdin: { contents: entry, resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife', loader: { '.css': 'empty' } });
const css = ':root{--bg:#0b100e;--text:#e6ece9;--text-strong:#fff;--muted:#86928b;--border:#26312c;--card:#111815;--bg-hover:#1a2320;--accent:#6fd3a3;--accent-subtle:#1a3528;--font-body:system-ui}body{margin:0;background:var(--bg)}' + await fs.readFile('src/control-ui.css', 'utf8');
const html = '<style>' + css + '</style><main></main><script>' + bundle.outputFiles[0].text + '</script>';
const browser = await chromium.launch({ headless: true, executablePath: process.env.KNOWLEDGE_BROWSER_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const errors = [], checks = [], gates = [];
let failRecords = false, failClaims = false, failStatus = false, failInitialRecords = false;
// A gate waits on an actual request and exposes completion without timing guesses.
function hold(operation, matches = () => true) {
  let release, entered, completed;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const finished = new Promise(resolve => { completed = resolve; });
  gates.push({ operation, matches, gate, entered, completed, release });
  return { release, started, finished };
}
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.setDefaultTimeout(10000); page.on('pageerror', error => { errors.push(error.message); console.error('Browser error:', error.message); });
  await page.exposeFunction('invokeKnowledge', async (operation, input) => {
    if (process.env.DEBUG_LOADING) console.error('request', operation, input.operation ?? '');
    const index = gates.findIndex(g => g.operation === operation && g.matches(input));
    const held = index >= 0 ? gates.splice(index, 1)[0] : undefined;
    if (held) { held.entered(); await held.gate; }
    try {
      if (operation === 'status' && failStatus) { failStatus = false; throw Error('Temporary initial status failure'); }
      if (operation === 'records' && failInitialRecords) { failInitialRecords = false; throw Error('Temporary initial records failure'); }
      if (operation === 'records' && failRecords && input.kind === 'relationship') { failRecords = false; throw Error('Temporary result failure'); }
      if (operation === 'connections' && input.direction === 'claims' && failClaims) { failClaims = false; throw Error('Temporary claims failure'); }
      return await service[operation](input, operatorContext(host.api, ['operator.admin']));
    } finally { held?.completed(); }
  });
  await page.route('https://knowledge.test/**', route => route.fulfill({ contentType: 'text/html', body: html }));
  const initial = hold('stores_snapshot');
  await page.goto('https://knowledge.test/plugin?plugin=knowledge&id=overview&p.view=browse'); await initial.started;
  assert.equal(await page.locator('.knowledge-header').count(), 1);
  assert.equal(await page.locator('.knowledge-browse-data .knowledge-placeholder').count(), 1);
  assert.equal(await page.locator('.knowledge-pagination,.knowledge-facet-count,.knowledge-empty').count(), 0);
  await page.screenshot({ path: base + '/first-load.png', fullPage: true });
  initial.release(); await page.locator('.knowledge-page-row').first().waitFor();
  console.log('check', checks.length + 1); checks.push('First load: destination frame + neutral skeleton, no invented totals or empty state');
  assert.equal(await page.locator('.knowledge-facets .knowledge-placeholder').count(), 0);
  for (const stage of ['status', 'records']) {
    if (stage === 'status') failStatus = true; else failInitialRecords = true;
    await page.reload(); await page.getByText('Temporary initial ' + stage + ' failure', { exact: true }).waitFor();
    assert.equal(await page.locator('.knowledge-content[aria-busy],.knowledge-content [aria-busy]').count(), 0);
    assert.equal(await page.locator('.knowledge-content .knowledge-placeholder').count(), 0, 'A failed first read must not still look loading');
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.locator('.knowledge-page-row').first().waitFor();
  }
  console.log('check', checks.length + 1); checks.push('Initial status/records errors end all loading states and retry successfully');
  await page.evaluate(() => { window.savedNodes = ['.knowledge-header','.knowledge-browse','.knowledge-facets','.knowledge-table-toolbar','.knowledge-browse-filter input','.knowledge-table thead'].map(s => [s,document.querySelector(s)]); });
  const history = hold('records');
  await page.getByRole('button', { name: 'Include history', exact: true }).click(); await history.started;
  assert.equal(await page.getByRole('button', { name: 'Include history', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.knowledge-browse-data').getAttribute('inert'), '');
  assert.match(await page.locator('.knowledge-pane-status').innerText(), /previous results/);
  await page.screenshot({ path: base + '/refresh-pending.png', fullPage: true });
  history.release(); await page.waitForFunction(() => !document.querySelector('.knowledge-content').hasAttribute('aria-busy'));
  assert.ok(await page.evaluate(() => window.savedNodes.every(([s,n]) => n === document.querySelector(s))), 'same-view controls and table headings stay mounted after commit');
  assert.ok(await page.getByRole('button', { name: 'Include history', exact: true }).evaluate(n => n === document.activeElement));
  console.log('check', checks.length + 1); checks.push('Lifecycle toggle: immediate selected state, inert old data, stable DOM + focus through commit');
  const back = hold('records');
  await page.goBack(); await back.started;
  assert.ok(await page.evaluate(() => window.savedNodes.every(([s,n]) => n === document.querySelector(s))), 'same-store browser history keeps mounted controls');
  back.release(); await page.waitForFunction(() => !document.querySelector('.knowledge-content').hasAttribute('aria-busy'));
  assert.equal(await page.getByRole('button', { name: 'Current', exact: true }).getAttribute('aria-pressed'), 'true');
  console.log('check', checks.length + 1); checks.push('Same-store browser history preserves the workspace through a held response');
  const forward = hold('records');
  await page.goForward(); await forward.started; forward.release();
  await page.waitForFunction(() => !document.querySelector('.knowledge-content').hasAttribute('aria-busy'));
  // A response may arrive while a new query is being typed but has not been submitted.
  const pending = hold('records');
  await page.getByRole('button', { name: 'Current', exact: true }).click(); await pending.started;
  const filter = page.getByRole('searchbox', { name: 'Filter by name or alias' });
  await filter.fill('unsent draft'); pending.release();
  await page.waitForFunction(() => !document.querySelector('.knowledge-content').hasAttribute('aria-busy'));
  assert.equal(await filter.inputValue(), 'unsent draft');
  assert.ok(await filter.evaluate(n => n === document.activeElement));
  await filter.fill('');
  console.log('check', checks.length + 1); checks.push('Pending response preserves focused input and unsent draft');
  // A failed refresh keeps prior results visible and retry scoped to the results pane.
  failRecords = true;
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.getByText('Temporary result failure', { exact: true }).waitFor();
  assert.equal(await page.locator('.knowledge-page-row').count(), 2);
  assert.equal(await page.locator('.knowledge-pane-status button').innerText(), 'Retry');
  assert.equal(await page.locator('.knowledge-browse-data').getAttribute('aria-busy'), null, 'A failed request is no longer pending');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.knowledge-content').hasAttribute('aria-busy'));
  assert.equal(await page.locator('.knowledge-pane-status').innerText(), '');
  console.log('check', checks.length + 1); checks.push('Refresh failure: previous data stays visible; retry is local');
  // Stale claims cannot replace a newer Pages selection.
  await page.evaluate(() => { window.settledRequests = []; });
  const stale = hold('records', input => input.kind === 'claim');
  await page.getByRole('button', { name: 'Claims', exact: true }).click(); await stale.started;
  await page.getByRole('button', { name: 'Pages', exact: true }).click();
  await page.locator('.knowledge-page-row').first().waitFor(); stale.release(); await stale.finished;
  // Browser macrotask acknowledgment runs after the feature client's stale continuation.
  await page.waitForFunction(() => window.settledRequests.some(request => request.op === 'records' && request.kind === 'claim'));
  await page.waitForFunction(() => !document.querySelector('.knowledge-content').hasAttribute('aria-busy'));
  assert.equal(await page.locator('.knowledge-claim').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Pages', exact: true }).getAttribute('aria-pressed'), 'true');
  console.log('check', checks.length + 1); checks.push('Out-of-order result cannot overwrite the latest selection');
  await page.getByRole('button', { name: 'Claims', exact: true }).click();
  await page.getByRole('heading', { name: 'Nothing here yet', exact: true }).waitFor();
  assert.equal(await page.locator('.knowledge-content .knowledge-placeholder').count(), 0);
  await page.getByRole('button', { name: 'Pages', exact: true }).click(); await page.locator('.knowledge-page-row').first().waitFor();
  console.log('check', checks.length + 1); checks.push('Zero-claims success replaces all facet and result placeholders with the real empty state');
  const recent = hold('recent');
  await page.getByRole('button', { name: 'Recent', exact: true }).click(); await recent.started;
  assert.equal(await page.locator('.knowledge-browse').count(), 0);
  assert.equal(await page.locator('.knowledge-placeholder-feed').count(), 1);
  recent.release(); await page.locator('.knowledge-feed-item').first().waitFor();
  const recentReload = hold('recent');
  await page.getByRole('button', { name: 'Recent', exact: true }).click(); await recentReload.started;
  assert.equal(await page.locator('.knowledge-view-data').getAttribute('inert'), '');
  assert.ok(await page.locator('.knowledge-feed-item').count());
  recentReload.release(); await page.waitForFunction(() => !document.querySelector('.knowledge-content').hasAttribute('aria-busy'));
  await page.getByRole('searchbox', { name: 'Search knowledge' }).fill('Northwind');
  await page.getByRole('searchbox', { name: 'Search knowledge' }).press('Enter'); await page.locator('.knowledge-search-hit').first().waitFor();
  const search = hold('grep');
  await page.getByRole('searchbox', { name: 'Search knowledge' }).fill('Alex');
  await page.getByRole('searchbox', { name: 'Search knowledge' }).press('Enter'); await search.started;
  assert.equal(await page.locator('.knowledge-view-data').getAttribute('inert'), '');
  assert.equal(await page.locator('.knowledge-search-hit').count(), 1);
  search.release(); await page.waitForFunction(() => !document.querySelector('.knowledge-content').hasAttribute('aria-busy'));
  assert.equal(await page.locator('.knowledge-view-data').getAttribute('inert'), null);
  await page.getByRole('button', { name: 'Recent', exact: true }).click(); await page.locator('.knowledge-feed-item').first().waitFor();
  console.log('check', checks.length + 1); checks.push('Recent and Search reloads keep local stale data inert without disabling search controls');
  const browse = hold('records');
  await page.getByRole('button', { name: 'Browse', exact: true }).click(); await browse.started;
  assert.equal(await page.locator('.knowledge-feed-item').count(), 0);
  assert.equal(await page.locator('.knowledge-browse-data .knowledge-placeholder').count(), 1);
  browse.release(); await page.locator('.knowledge-page-row').first().waitFor();
  console.log('check', checks.length + 1); checks.push('Tab changes show the destination skeleton, never old content under a new tab');
  // Once primary content arrives, one failed panel must not remove a sibling skeleton.
  failClaims = true; const connections = hold('connections', input => input.direction === 'outgoing');
  const primary = hold('record', input => input.id === project.id);
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.getByRole('button', { name: 'Northwind launch', exact: true }).click(); await primary.started;
  assert.equal(await page.locator('.knowledge-placeholder-detail').count(), 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: base + '/detail-loading-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 1000 });
  primary.release(); await connections.started;
  await page.getByRole('heading', { name: 'Northwind launch', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Retry claims', exact: true }).waitFor();
  assert.ok(await page.getByText('Readable project body.', { exact: true }).isVisible());
  assert.ok(await page.getByText('Loading connections…', { exact: true }).isVisible());
  await page.getByRole('button', { name: 'Retry claims', exact: true }).click();
  await page.getByText(/No claims about Northwind launch/).waitFor();
  assert.ok(await page.getByText('Loading connections…', { exact: true }).isVisible());
  connections.release(); await page.getByText('No connections recorded.', { exact: true }).waitFor();
  console.log('check', checks.length + 1); checks.push('Independent secondary panel placeholders, failure, and retry preserve primary content');
  // Store selection is a hard privacy boundary: retained results belong only to the old store.
  const other = hold('agent_query', input => input.agent === 'other' && input.operation === 'status');
  await page.selectOption('.knowledge-agent-select select', 'other'); await other.started;
  assert.equal(await page.getByRole('heading', { name: 'Northwind launch', exact: true }).count(), 0);
  assert.equal(await page.locator('.knowledge-placeholder-feed').count(), 1);
  other.release(); await page.getByText('Other private project', { exact: true }).first().waitFor();
  console.log('check', checks.length + 1); checks.push('Agent switch clears prior-store content before new-store reads');
  for (const width of [1280,390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.getByRole('button', { name: 'Browse', exact: true }).click();
    await page.locator('.knowledge-page-row').first().waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: base + '/browse-' + width + '.png', fullPage: true });
  }
  console.log('check', checks.length + 1); checks.push('Desktop/mobile screenshots and no horizontal overflow');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, artifacts: base, project: project.id }, null, 2));
} finally {
  // Release held RPCs before shutdown even when an assertion fails.
  for (const gate of gates) gate.release();
  await browser.close(); for (const lifecycle of lifecycles) await lifecycle.stop();
}
