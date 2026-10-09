// Real browser and Knowledge service; a person page with many evidence entries must open.
// Run after TypeScript compilation: node test/browser/evidence-heavy-record.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { createKnowledgeService } from '../../dist/service.js';
import { hostApi, toolContext, operatorContext } from '../support.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(await fs.realpath('node_modules/openclaw') + '/node_modules/playwright');
const base = await fs.realpath(await fs.mkdtemp('/tmp/knowledge-evidence-heavy-'));
const host = hostApi(base, { agents: ['main'], policy: { operatorRead: true, writesEnabled: true } });
const lifecycles = [];
host.api.registerService = service => lifecycles.push(service);
const service = createKnowledgeService(host.api, { emit: () => {} });
// Long titles, an unresolved identity and a dated meeting exercise every row variant.
// One retained transcript cited at many line ranges, as repeated meeting ingestion produces.
const transcript = Array.from({ length: 200 }, (_, i) => `Speaker ${i % 3}: line ${i + 1} mentions Josh.`).join('\n');
const source = await service.attach({ requestId: randomUUID(), filename: 'meeting-transcript.txt', mediaType: 'text/plain', attribution: 'Granola meeting transcript', offset: 0, data: Buffer.from(transcript).toString('base64'), final: true }, toolContext(host.api));
const attachments = Array.from({ length: 90 }, (_, i) => ({ ...source.evidence, start_line: i + 1, end_line: i + 2 }));
const saved = await service.save_page({ requestId: randomUUID(), title: 'Josh Lehman', type: 'person', body: 'Maintains OpenClaw.\n\n' + 'Long synthesized notes. '.repeat(1200), aliases: ['Josh'], attachments }, toolContext(host.api));
// Agent-written claim bodies can end in an internal comment that the card must not show.
const fingerprint = (await service.ontology({}, toolContext(host.api))).fingerprint;
await service.create_claim({ requestId: randomUUID(), expectedOntologyFingerprint: fingerprint, title: 'Release focus', body: 'Josh favored focused releases. <!-- project: path:/private/workspace -->', claim_kind: 'decision', assertion_origin: 'source', attribution: 'Granola meeting transcript', evidence: [{ ...source.evidence, start_line: 3, end_line: 3 }], entities: [saved.id] }, toolContext(host.api));
const entry = "import plugin from './src/control-ui.ts';\nconst signal=new AbortController().signal;\nconst host={pluginId:'knowledge',signal,connection:{connected:true},redact:String,\n request:async(method,p)=>({ok:true,result:await window.invokeKnowledge(p.actionId,p.payload)}),\n onEvent:()=>()=>{},subscribe:()=>()=>{},agents:{rows:[{id:'main',name:'Main'}],selectedId:'main'},\n sessions:{create:async()=>'x',open:()=>{}},navigation:{openPage:()=>{}},\n ui:{registerNavigation:()=>()=>{},registerPage:view=>{view.mount(document.querySelector('main'),{host,signal,props:Object.fromEntries(new URL(location.href).searchParams)});return()=>{}}}};\nplugin.activate(host);";
const bundle = await build({ stdin: { contents: entry, resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife', loader: { '.css': 'empty' } });
const css = ':root{--bg:#0b100e;--text:#e6ece9;--text-strong:#fff;--muted:#86928b;--border:#26312c;--card:#111815;--bg-hover:#1a2320;--accent:#6fd3a3;--warn:#e3b55c;--warn-subtle:#2a2416;--font-body:system-ui}*{box-sizing:border-box}body{margin:0;background:var(--bg)}' + await fs.readFile('src/control-ui.css', 'utf8');
const html = '<style>' + css + '</style><main></main><script>' + bundle.outputFiles[0].text + '</script>';
const browser = await chromium.launch({ headless: true, executablePath: process.env.KNOWLEDGE_BROWSER_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const errors = [], failures = [];
try {
  const page = await browser.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', e => errors.push(e.message));
  await page.exposeFunction('invokeKnowledge', async (op, input) => {
    try { return await service[op](input, operatorContext(host.api, ['operator.admin'])); } catch (error) { failures.push(op + ': ' + error.message); throw error; }
  });
  await page.route('https://knowledge.test/**', route => route.fulfill({ contentType: 'text/html', body: html }));
  // Expanded evidence alone exceeds the record budget, so the page must open from compact metadata.
  const full = await service.record({ id: saved.id, view: 'summary', metadataView: 'full' }, toolContext(host.api));
  assert.ok(full.omitted?.includes('metadata.evidence'), 'expanded evidence exceeds the budget in this fixture');
  await page.goto('https://knowledge.test/?record=' + saved.id);
  await page.locator('.knowledge-entity-header h2').filter({ hasText: 'Josh Lehman' }).waitFor();
  assert.match(await page.locator('.knowledge-entity-header').innerText(), /Josh/);
  assert.equal(await page.getByText('Maintains OpenClaw.').count(), 1);
  // Truncated notes offer the next part without notices; claim cards hide internal comments.
  await page.getByRole('button', { name: 'Read more notes', exact: true }).waitFor();
  await page.locator('.knowledge-claim-text', { hasText: 'Josh favored focused releases.' }).waitFor();
  const visible = await page.locator('main').innerText();
  assert.doesNotMatch(visible, /Preview is truncated|Some supporting previews|Showing part of this record|<!--|path:\/private/);
  // Structured metadata loads only when opened, without the expanded evidence list.
  await page.locator('.knowledge-file-details > summary').click();
  await page.locator('.knowledge-technical-details > summary').click();
  const structured = page.locator('.knowledge-technical-details details').filter({ hasText: 'Structured metadata' });
  await structured.locator('summary').click();
  await page.waitForFunction(() => !document.querySelector('.knowledge-technical-details pre')?.textContent?.startsWith('Loading'));
  const text = await structured.locator('pre').innerText();
  assert.match(text, /"title": "Josh Lehman"/);
  assert.match(text, /Evidence descriptors omitted for size/);
  assert.deepEqual(failures, []); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: 'evidence-heavy person page opens from compact metadata without notices or comment text; structured metadata loads on demand without expanded evidence', artifacts: base }));
} finally { await browser.close(); for (const lifecycle of lifecycles) await lifecycle.stop(); }
