// Real browser and Knowledge service; checks the Browse pages list at desktop and phone widths.
// Run after TypeScript compilation: node test/browser/browse-layout.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { createKnowledgeService } from '../../dist/service.js';
import { hostApi, toolContext, operatorContext } from '../support.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(await fs.realpath('node_modules/openclaw') + '/node_modules/playwright');
const base = await fs.realpath(await fs.mkdtemp('/tmp/knowledge-browse-layout-'));
const host = hostApi(base, { agents: ['main'], policy: { operatorRead: true, writesEnabled: true } });
const lifecycles = [];
host.api.registerService = service => lifecycles.push(service);
const service = createKnowledgeService(host.api, { emit: () => {} });
// Long titles, an unresolved identity and a dated meeting exercise every row variant.
const pages = [
  { title: 'Mollie Anderson', type: 'person' },
  { title: 'Knowledge dreaming should be simpler than gbrain', type: 'concept' },
  { title: 'Hermes', type: 'company', identity: { status: 'partial', context: 'Mentioned once.' } },
  { title: 'Weekly sync with Red Hat about the launch plan', type: 'meeting', fields: { occurred_at: '2026-10-06' } },
];
for (const page of pages) await service.save_page({ requestId: randomUUID(), body: page.title + '.', ...page }, toolContext(host.api));
const entry = "import plugin from './src/control-ui.ts';\nconst signal=new AbortController().signal;\nconst host={pluginId:'knowledge',signal,connection:{connected:true},redact:String,\n request:async(method,p)=>({ok:true,result:await window.invokeKnowledge(p.actionId,p.payload)}),\n onEvent:()=>()=>{},subscribe:()=>()=>{},agents:{rows:[{id:'main',name:'Main'}],selectedId:'main'},\n sessions:{create:async()=>'x',open:()=>{}},navigation:{openPage:()=>{}},\n ui:{registerNavigation:()=>()=>{},registerPage:view=>{view.mount(document.querySelector('main'),{host,signal,props:Object.fromEntries(new URL(location.href).searchParams)});return()=>{}}}};\nplugin.activate(host);";
const bundle = await build({ stdin: { contents: entry, resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife', loader: { '.css': 'empty' } });
const css = ':root{--bg:#0b100e;--text:#e6ece9;--text-strong:#fff;--muted:#86928b;--border:#26312c;--card:#111815;--bg-hover:#1a2320;--accent:#6fd3a3;--warn:#e3b55c;--warn-subtle:#2a2416;--font-body:system-ui}*{box-sizing:border-box}body{margin:0;background:var(--bg)}' + await fs.readFile('src/control-ui.css', 'utf8');
const html = '<style>' + css + '</style><main></main><script>' + bundle.outputFiles[0].text + '</script>';
const browser = await chromium.launch({ headless: true, executablePath: process.env.KNOWLEDGE_BROWSER_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const errors = [];
try {
  const page = await browser.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', e => errors.push(e.message));
  await page.exposeFunction('invokeKnowledge', (op, input) => service[op](input, operatorContext(host.api, ['operator.admin'])));
  await page.route('https://knowledge.test/**', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('https://knowledge.test/?view=browse');
  await page.locator('.knowledge-table').waitFor();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    // Rows group under a day heading and show a compact time with the full date in its tooltip.
    assert.equal(await page.locator('.knowledge-day-row').first().innerText(), 'TODAY');
    const updated = page.locator('.knowledge-updated-cell').first();
    assert.match(await updated.innerText(), /^\d{1,2}:\d{2}/);
    assert.match(await updated.getAttribute('title'), /\d{4}/);
    // Only dated records carry occurrence text.
    assert.equal(await page.locator('.knowledge-occurred-cell:not(:empty)').count(), 1);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No horizontal overflow');
    // Titles wrap by word: the long title's widest line is wider than a few characters.
    const titleWidth = await page.locator('.knowledge-record-title', { hasText: 'Knowledge dreaming' }).evaluate(n => n.getBoundingClientRect().width);
    assert.ok(titleWidth > 150, `title column too narrow: ${titleWidth}`);
    await page.screenshot({ path: base + '/browse-' + width + '.png', fullPage: true });
  }
  // On phones the header is visually hidden but kept for assistive technology.
  assert.ok(await page.locator('.knowledge-table thead').evaluate(n => n.getBoundingClientRect().height <= 1));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: 'day headings, compact times, sparse occurrence, no overflow, word-wrapped titles, desktop/mobile', artifacts: base }));
} finally { await browser.close(); for (const lifecycle of lifecycles) await lifecycle.stop(); }
