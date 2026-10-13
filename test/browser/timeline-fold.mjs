// Real browser and Knowledge service; long Timeline sections fold older months on record pages.
// Run after TypeScript compilation: node test/browser/timeline-fold.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { createKnowledgeService } from '../../dist/service.js';
import { hostApi, toolContext, operatorContext } from '../support.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(await fs.realpath('node_modules/openclaw') + '/node_modules/playwright');
const base = await fs.realpath(await fs.mkdtemp('/tmp/knowledge-timeline-fold-'));
const host = hostApi(base, { agents: ['main'], policy: { operatorRead: true, writesEnabled: true } });
const lifecycles = [];
host.api.registerService = service => lifecycles.push(service);
const service = createKnowledgeService(host.api, { emit: () => {} });
// Long titles, an unresolved identity and a dated meeting exercise every row variant.
// Twelve entries authored oldest first across two months, as a loose list (blank lines between items).
const dates = ['2026-08-28', '2026-08-30', '2026-09-01', '2026-09-03', '2026-09-08', '2026-09-10', '2026-09-15', '2026-09-17', '2026-09-22', '2026-09-24', '2026-09-29', '2026-10-01'];
const timeline = dates.map(date => `- **${date} — Standup:** Discussed release ${date}.`).join('\n\n');
const saved = await service.save_page({ requestId: randomUUID(), title: 'Josh Lehman', type: 'person', body: '## State\n\nMaintains OpenClaw.\n\n## Timeline\n\n' + timeline + '\n\n## Notes\n\nAfter the timeline.' }, toolContext(host.api));
const entry = "import plugin from './src/control-ui.ts';\nconst signal=new AbortController().signal;\nconst host={pluginId:'knowledge',signal,connection:{connected:true},redact:String,\n request:async(method,p)=>({ok:true,result:await window.invokeKnowledge(p.actionId,p.payload)}),\n onEvent:()=>()=>{},subscribe:()=>()=>{},agents:{rows:[{id:'main',name:'Main'}],selectedId:'main'},\n sessions:{create:async()=>'x',open:()=>{}},navigation:{openPage:()=>{}},\n ui:{registerNavigation:()=>()=>{},registerPage:view=>{view.mount(document.querySelector('main'),{host,signal,props:Object.fromEntries(new URL(location.href).searchParams)});return()=>{}}}};\nplugin.activate(host);";
const bundle = await build({ stdin: { contents: entry, resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife', loader: { '.css': 'empty' } });
const css = ':root{--bg:#0b100e;--text:#e6ece9;--text-strong:#fff;--muted:#86928b;--border:#26312c;--card:#111815;--bg-hover:#1a2320;--accent:#6fd3a3;--warn:#e3b55c;--warn-subtle:#2a2416;--font-body:system-ui}*{box-sizing:border-box}body{margin:0;background:var(--bg)}' + await fs.readFile('src/control-ui.css', 'utf8');
const html = '<style>' + css + '</style><main></main><script>' + bundle.outputFiles[0].text + '</script>';
const browser = await chromium.launch({ headless: true, executablePath: process.env.KNOWLEDGE_BROWSER_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } }); page.setDefaultTimeout(10000);
  page.on('pageerror', e => errors.push(e.message));
  await page.exposeFunction('invokeKnowledge', (op, input) => service[op](input, operatorContext(host.api, ['operator.admin'])));
  await page.route('https://knowledge.test/**', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('https://knowledge.test/?record=' + saved.id);
  await page.locator('.knowledge-markdown h2', { hasText: 'Timeline' }).waitFor();
  // The newest five stay open, newest first.
  const recent = await page.locator('.knowledge-markdown h2:text-is("Timeline") + ul > li').allInnerTexts();
  assert.deepEqual(recent.map(text => text.slice(0, 10)), ['2026-10-01', '2026-09-29', '2026-09-24', '2026-09-22', '2026-09-17']);
  // Older entries fold by month, closed, with counts; nothing is lost and later sections stay put.
  const groups = page.locator('.knowledge-timeline-group');
  assert.deepEqual(await groups.locator('summary').allInnerTexts(), ['September 2026 · 5 entries', 'August 2026 · 2 entries']);
  assert.equal(await groups.evaluateAll(nodes => nodes.filter(n => n.open).length), 0);
  assert.equal(await page.locator('.knowledge-markdown li').count(), dates.length);
  assert.equal(await page.locator('.knowledge-timeline-group + h2', { hasText: 'Notes' }).count(), 1);
  await groups.first().locator('summary').click();
  assert.match(await groups.first().innerText(), /2026-09-15[\s\S]*2026-09-01/);
  await page.screenshot({ path: base + '/timeline-390.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: 'newest five open, older months folded with counts, no entries lost', artifacts: base }));
} finally { await browser.close(); for (const lifecycle of lifecycles) await lifecycle.stop(); }
