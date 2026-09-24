// Rendered Markdown/security regression under a real browser, no live vault writes.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);
const { chromium } = require(await fs.realpath('node_modules/openclaw') + '/node_modules/playwright');
const base = await fs.mkdtemp('/tmp/knowledge-markdown-browser-');
const bundle = await build({ stdin: { contents: `import {markdownView} from './src/markdown-view.ts'; window.render = source => document.querySelector('main').replaceChildren(markdownView(source, id => {window.openedRecord = id}));`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife' });
const browser = await chromium.launch({ headless: true, executablePath: process.env.KNOWLEDGE_BROWSER_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push(request.url()));
  await page.setContent('<style>:root{--text:#18221b;--muted:#66736b;--border:#c7d2cc;--accent:#247044;--bg:#fff}*{box-sizing:border-box}body{margin:20px}main{max-width:760px;margin:auto}</style><main class="knowledge-page knowledge-summary"></main>');
  await page.addStyleTag({ content: await fs.readFile('src/control-ui.css', 'utf8') });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const id = '0422d1aa-3d45-4d44-91ae-f2eac3490c3f';
  const source = '# Vincent Koc\n\nParticipated in **communications planning**.\n\n## State and source context\n\n- **2026-09-23:** Roundtable planning\n  - _Optional_ attendance\n- ~~Superseded~~ item\n\n## Timeline\n\n1. Planning\n2. [COMMAND weekly](../meetings/' + id + '.md)\n\n> Source quotation\n\n| Date | Meeting |\n| --- | --- |\n| Sep 23 | Weekly |\n\n- [x] Recorded\n- [ ] Follow up\n\n```html\n<script>window.pwned = true</script>\n' + 'x'.repeat(250) + '\n```\n\n[Documentation](https://example.com/docs)\n\n[Unsafe](javascript:alert%281%29) [Encoded](jav&#x61;script:alert%281%29) [File](file:///etc/passwd) [Data](data:text/html,hi) [Host](/settings) [Protocol-relative](//example.com)\n\n<img src="https://example.com/track" onerror="window.pwned=true">\n<script>window.pwned=true</script>\n<form><input autofocus onfocus="window.pwned=true"></form>\n<svg onload="window.pwned=true"></svg>\n\n![Remote image](https://example.com/image.png)';
  await page.evaluate(source => window.render(source), source);
  assert.equal(await page.locator('h1').innerText(), 'Vincent Koc');
  assert.equal(await page.locator('h2').count(), 2);
  assert.equal(await page.locator('strong').count(), 2);
  assert.equal(await page.locator('ul ul li em').innerText(), 'Optional');
  assert.equal(await page.locator('ol > li').count(), 2);
  assert.equal(await page.locator('blockquote').innerText(), 'Source quotation');
  assert.equal(await page.locator('table tbody td').count(), 2);
  assert.equal(await page.locator('input[type=checkbox]:disabled').count(), 2);
  assert.equal(await page.locator('input:checked').count(), 1);
  assert.match(await page.locator('pre code').innerText(), /<script>/);
  assert.equal(await page.locator('main script,main img,main svg,main form,main iframe,main [onerror],main [onload]').count(), 0);
  assert.equal(await page.evaluate(() => window.pwned), undefined);
  assert.deepEqual(requests, [], 'Opening Markdown never loads remote embedded assets');
  assert.equal(await page.locator('a[href]').count(), 2);
  const external = page.getByRole('link', {name: 'Documentation'});
  assert.equal(await external.getAttribute('target'), '_blank');
  assert.equal(await external.getAttribute('rel'), 'noopener noreferrer');
  await page.getByRole('link', {name:'COMMAND weekly'}).click();
  assert.equal(await page.evaluate(() => window.openedRecord), id);
  for (const width of [1000, 390]) {
    await page.setViewportSize({width, height:900});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({path: `${base}/markdown-${width}.png`, fullPage:true});
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({passed:'Markdown semantics, scoped record links, inert hostile content, zero remote embeds, mobile layout',artifacts:base}));
} finally { await browser.close(); }
