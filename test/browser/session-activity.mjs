import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { createKnowledgeService } from '../../dist/service.js';
import { hostApi, toolContext, operatorContext } from '../support.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(await fs.realpath('node_modules/openclaw') + '/node_modules/playwright');
const base = await fs.realpath(await fs.mkdtemp('/tmp/knowledge-session-browser-'));
const fixture = hostApi(base, { policy: { operatorRead: true, writesEnabled: true } });
const lifecycles = []; fixture.api.registerService = service => lifecycles.push(service);
const service = createKnowledgeService(fixture.api, { emit() {} });
const ctx = () => ({ ...toolContext(fixture.api), toolCallId: randomUUID(), tool: { ...toolContext(fixture.api).tool, sessionKey: 'agent:main:demo', sessionId: 'demo-id' } });
const pageInput = { requestId: randomUUID(), title: 'Launch decision', type: 'note', body: 'We chose a small launch. **Evidence stays inspectable.**' };
const saved = await service.save_page(pageInput, ctx());
await service.record({ id: saved.id }, ctx());
const second = await service.save_page({ requestId: randomUUID(), title: 'Follow-up plan', type: 'note', body: 'Check the rollout tomorrow.' }, ctx());
const entry = `import {registerSessionPanel} from './src/session-panel.ts';
let view,handle;const listeners=new Set(),signal=new AbortController().signal;let sessionId='demo-id',presented=true;
const context=()=>({host,signal,props:{sessionKey:'agent:main:demo',agentId:'main'},presented});
const host={signal,pluginId:'knowledge',connection:{connected:true},redact:String,
request:async(method,p)=>{if(p.payload?.operation==='session_activity')window.activityRequests=(window.activityRequests??0)+1;try{return{ok:true,result:await window.invokeKnowledge(p.actionId,p.payload)}}catch(e){return{ok:false,error:e.message}}},
onEvent:()=>()=>{},subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},
sessions:{normalizeKey:k=>k,get rows(){return[{key:'agent:main:demo',sessionId,agentId:'main'}]}},
navigation:{pageHref:({params})=>'/plugin?plugin=knowledge&id=overview&'+new URLSearchParams(Object.fromEntries(Object.entries(params).map(([k,v])=>['p.'+k,v]))),openPage:target=>window.opened=target},
ui:{registerPanel:p=>{view=p;return()=>{}},registerAction:()=>()=>{},openPanel:()=>{}}};
registerSessionPanel(host);handle=view.mount(document.querySelector('main'),context());
window.hostUpdate=()=>handle.update(context());window.setPresented=value=>{presented=value;handle.update(context())};window.switchSession=id=>{sessionId=id;handle.update(context())};window.disconnect=()=>{host.connection.connected=false;for(const fn of listeners)fn()};window.reconnect=()=>{host.connection.connected=true;for(const fn of listeners)fn()};window.dispose=()=>handle.dispose();`;
const bundle = await build({ stdin: { contents: entry, resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife', loader: { '.css': 'empty' } });
const html = `<style>:root{--bg:#fff;--text:#18221b;--text-strong:#0b120d;--muted:#66736b;--border:#c7d2cc;--accent:#247044}*{box-sizing:border-box}body{margin:0;font-family:system-ui}main{height:100vh}${await fs.readFile('src/control-ui.css','utf8')}</style><main></main><script>${bundle.outputFiles[0].text}</script>`;
const browser = await chromium.launch({headless:true,executablePath:process.env.KNOWLEDGE_BROWSER_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const errors = [], checks = [];let delay, activityDelay;let activityCalls=0;
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 850 } });page.setDefaultTimeout(10000);
  page.on('pageerror', e => errors.push(e.message));
  await page.exposeFunction('invokeKnowledge', async (op,input) => {
    if(op==='agent_query' && input.operation==='session_activity'){activityCalls++;if(activityDelay){const wait=activityDelay;activityDelay=null;wait.started();await wait.promise;}}
    if(op==='agent_query' && input.operation==='record' && delay){const wait=delay;delay=null;wait.started();await wait.promise;}
    return service[op](input, operatorContext(fixture.api));
  });
  await page.route('https://knowledge.test/**', route => route.fulfill({contentType:'text/html',body:html}));
  await page.clock.install();
  await page.goto('https://knowledge.test');
  await page.waitForFunction(()=>document.querySelectorAll('.knowledge-session-item').length===3 && !document.querySelector('.knowledge-session-list + button').disabled);
  assert.equal(await page.locator('.knowledge-session-title').first().textContent(),'Follow-up plan');
  assert.equal(await page.getByRole('button',{name:'Refresh',exact:true}).count(),0);
  assert.doesNotMatch(await page.locator('.knowledge-session-panel').innerText(),/revision|activities shown|best-effort/);
  await page.screenshot({path:'/tmp/knowledge-session-cards.png',fullPage:true});
  const beforeUpdates=activityCalls;
  await page.evaluate(async()=>{for(let i=0;i<25;i++){window.hostUpdate();await new Promise(requestAnimationFrame);}});
  assert.equal(activityCalls,beforeUpdates,'ordinary host updates must not reload activity');
  let releasePoll,enteredPoll;
  const pollStarted=new Promise(r=>enteredPoll=r);
  activityDelay={promise:new Promise(r=>releasePoll=r),started:enteredPoll};
  await page.clock.runFor(10000);await pollStarted;
  assert.equal(await page.locator('.knowledge-session-card').count(),3,'background poll preserves the visible cards');
  releasePoll();await page.waitForFunction(()=>!document.querySelector('.knowledge-session-list + button').disabled);
  await page.clock.resume();
  await page.evaluate(()=>window.setPresented(false));
  const beforeOpen=activityCalls;
  await page.evaluate(()=>window.setPresented(true));
  await page.waitForFunction(n=>window.activityRequests>n,beforeOpen);
  await page.waitForFunction(()=>!document.querySelector('.knowledge-session-list + button').disabled);
  await page.getByRole('button',{name:'Follow-up plan',exact:true}).waitFor();
  assert.ok(activityCalls>beforeOpen,'reopening the panel refreshes activity');
  checks.push('host rerenders do not reload; background polling preserves cards; reopening refreshes');

  await page.getByRole('button',{name:'Oldest first',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'Oldest first',exact:true}).getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('.knowledge-session-title').first().textContent(),'Launch decision');
  await page.getByRole('button',{name:'Oldest first',exact:true}).press('Space');
  assert.equal(await page.locator('.knowledge-session-title').first().textContent(),'Follow-up plan');
  assert.equal(await page.getByRole('button',{name:'Oldest first',exact:true}).getAttribute('aria-pressed'),'false');
  await page.getByRole('button',{name:'Writes',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.knowledge-session-item').length===2 && !document.querySelector('.knowledge-session-list + button').disabled);
  assert.equal(await page.getByRole('button',{name:'Writes',exact:true}).getAttribute('aria-pressed'),'true');
  await page.getByRole('button',{name:'Reads',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.knowledge-session-item').length===1 && !document.querySelector('.knowledge-session-list + button').disabled);
  await page.getByRole('button',{name:'Launch decision',exact:true}).click();
  await page.getByText('Evidence stays inspectable.',{exact:true}).waitFor();
  const href=await page.getByRole('link',{name:'Open full page'}).getAttribute('href');
  assert.ok(href.includes('p.agent=main')&&href.includes('p.vault=')&&href.includes(saved.id));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:'/tmp/knowledge-session-activity.png',fullPage:true});
  checks.push('narrow panel, chronology, filters, preview and scoped page links');
  await page.getByRole('link',{name:'Open full page'}).click();
  assert.equal((await page.evaluate(()=>window.opened)).params.record,saved.id);
  await page.getByRole('button',{name:'Back to activity'}).click();
  await page.getByRole('button',{name:'All activity',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.knowledge-session-item').length===3 && !document.querySelector('.knowledge-session-list + button').disabled);
  let release,started;const gate=new Promise(r=>release=r);const entered=new Promise(r=>started=r);delay={promise:gate,started};
  await page.getByRole('button',{name:'Follow-up plan',exact:true}).click();await entered;
  await page.evaluate(()=>window.switchSession('reset-id'));
  await page.getByText('No activity yet.',{exact:true}).waitFor();release();
  await page.evaluate(()=>window.hostUpdate());
  assert.equal(await page.locator('.knowledge-session-preview').isVisible(),false);
  assert.equal(await page.locator('.knowledge-session-item').count(),0);
  checks.push('session reset fences late preview and clears old activity');
  await page.evaluate(()=>window.switchSession('demo-id'));await page.waitForFunction(()=>document.querySelectorAll('.knowledge-session-item').length===3 && !document.querySelector('.knowledge-session-list + button').disabled);
  await page.evaluate(()=>window.disconnect());await page.getByText('Disconnected.',{exact:false}).waitFor();
  await page.evaluate(()=>window.reconnect());await page.waitForFunction(()=>document.querySelectorAll('.knowledge-session-item').length===3 && !document.querySelector('.knowledge-session-list + button').disabled);
  checks.push('reconnect refresh');
  await page.evaluate(()=>window.dispose());assert.equal(await page.locator('.knowledge-session-panel').count(),0);
  assert.deepEqual(errors,[]);console.log(JSON.stringify({checks,errors,screenshot:'/tmp/knowledge-session-activity.png'}));
} finally {await browser.close();for(const lifecycle of lifecycles)await lifecycle.stop();await fs.rm(base,{recursive:true,force:true});}
