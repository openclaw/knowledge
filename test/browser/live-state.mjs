// Isolated rendered integration check. Uses host Playwright, no additional dependency.
// Run after TypeScript compilation: node test/browser/live-state.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { createKnowledgeService } from '../../dist/service.js';
const require=createRequire(import.meta.url);
const {chromium}=require(await fs.realpath('node_modules/openclaw')+'/node_modules/playwright');
const base=await fs.realpath(await fs.mkdtemp('/tmp/knowledge-live-browser-'));
await fs.mkdir(base+'/vault/private',{recursive:true});
const manifest={format:'knowledge-vault-v1',vaultId:randomUUID(),agentId:'main',generation:0,publicationId:randomUUID()};
await fs.writeFile(base+'/vault/vault.json',JSON.stringify(manifest));
const services=[]; let page, cappedSearch=false;
const requests=[], errors=[];
const ownerSessionId=randomUUID();
const api={runtime:{agent:{session:{getSessionEntry:()=>({sessionId:ownerSessionId,chatType:"direct"})}}},pluginConfig:{vault:{root:base+'/vault',statePath:base+'/state.sqlite',agentId:'main',vaultId:manifest.vaultId,publicationId:manifest.publicationId,operatorRead:true,writesEnabled:true}},registerService:s=>services.push(s)};
const service=createKnowledgeService(api,{emit:(event,payload)=>{void page?.evaluate(({event,payload})=>window.emit?.(event,payload),{event,payload}).catch(()=>{});}});
const context={source:'session-action',api,action:{client:{connId:'isolated-browser',scopes:['operator.write']}}};
const agentContext={source:"tool",api,tool:{agentId:"main",sessionId:ownerSessionId,sessionKey:"agent:main:browser-lifecycle-test",senderIsOwner:true,assertInvocationCurrent(){}}};
const browser=await chromium.launch({headless:true,args:['--disable-gpu'],executablePath:process.env.KNOWLEDGE_BROWSER_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const entry=`import plugin from './src/control-ui.ts';
const listeners=new Set(), events=new Map(); let mounted, controller;
const host={pluginId:'knowledge',signal:new AbortController().signal,connection:{connected:true},redact:String,
 request:async(method,p)=>({ok:true,result:await window.invokeKnowledge(p.actionId,p.payload)}),
 onEvent:(name,fn)=>{events.set(name,fn);return()=>events.delete(name)},subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},
 sessions:{create:async(params)=>{window.createdChat=params;return "new-chat"},open:params=>{window.openedChat=params}},
 ui:{registerNavigation:()=>()=>{},registerPage:view=>{window.mount=()=>{controller=new AbortController();mounted=view.mount(document.querySelector('main'),{host,signal:controller.signal});};return()=>{}}}};
window.unmount=()=>{controller.abort();mounted.dispose()};
window.remount=()=>{window.unmount();window.mount()};
window.connect=connected=>{host.connection.connected=connected;for(const fn of listeners)fn()};
window.emit=(event,payload)=>{if(host.connection.connected)events.get('plugin.knowledge.'+event)?.(payload)};
window.subscriptions=()=>({events:events.size,connections:listeners.size});
plugin.activate(host);window.mount();`;
const bundle=await build({stdin:{contents:entry,resolveDir:process.cwd()},bundle:true,write:false,format:'iife',loader:{'.css':'empty'}});
const html='<html><head><style>:root{--bg:#fff;--text:#18221b;--muted:#66736b;--border:#c7d2cc;--card:#f5f8f6;--accent:#247044;--danger:#a32d26;--font-body:system-ui;--accent-subtle:#e3f1e8}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui}'+await fs.readFile('src/control-ui.css','utf8')+'</style></head><body><main></main><script>'+bundle.outputFiles[0].text+'</script></body></html>';
try {
  page=await browser.newPage({viewport:{width:1280,height:1000}});
  page.setDefaultTimeout(10000);
  await page.clock.install();
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://knowledge.test/**',route=>route.fulfill({contentType:'text/html',body:html}));
  await page.exposeFunction('invokeKnowledge',async(operation,input)=>{
    requests.push(operation);
    assert.ok(!['save_page','create_claim','create_relationship','resume','attach','correct','withdraw'].includes(operation),'The browser must never mutate knowledge');
    if (operation === 'grep' || operation === 'records') assert.ok((input.offset ?? 0) <= 500, 'UI never sends an invalid paging offset');
    const result=await service[operation](input,context);
    if (operation === 'grep' && cappedSearch) { result.nextOffset=520; result.total=600; }
    JSON.stringify(result);
    return result;
  });
  const project=await service.save_page({requestId:randomUUID(),title:'Northwind launch',type:'project',body:'A launch project for the Northwind team.\n\nThe agent maintains this summary.'},context);
  const person=await service.save_page({requestId:randomUUID(),title:'Alex Rivera',type:'person',body:'Alex leads Northwind.',aliases:['Alex']},context);
  const source=await service.save_page({requestId:randomUUID(),title:'Team standup',type:'meeting',body:'Launch planning',source:{text:'Alex will deliver on Friday.\nLaunch happened yesterday.',attribution:'Alex, team standup'}},context);
  const evidence=(await service.record({id:source.id,includeMetadata:true},context)).record.metadata.evidence;
  const fingerprint=(await service.ontology({},context)).fingerprint;
  const common={expectedOntologyFingerprint:fingerprint,evidence,attribution:'Alex, team standup',entities:[project.id]};
  const commitment=await service.create_claim({...common,requestId:randomUUID(),title:'Release commitment',body:'Alex will deliver on Friday.',claim_kind:'commitment',assertion_origin:'source',owner:person.id,due_at:'2026-09-25'},context);
  const inference=await service.create_claim({...common,requestId:randomUUID(),title:'Readiness inference',body:'The launch appears ready.',claim_kind:'belief',assertion_origin:'agent_inference'},context);
  await service.create_claim({...common,requestId:randomUUID(),title:'Launch event',body:'Launch happened yesterday.',claim_kind:'event',assertion_origin:'source',occurred_at:'2026-09-22'},context);
  await service.create_relationship({requestId:randomUUID(),expectedOntologyFingerprint:fingerprint,evidence,attribution:'Alex, team standup',title:'Alex leads Northwind',body:'Alex leads the launch project.',from:person.id,to:project.id,label:'leads'},context);
  services[0].start();
  await page.goto('https://knowledge.test/');
  await page.locator('.knowledge-feed-item').first().waitFor();
  assert.equal(await page.getByRole('button',{name:/New page|New claim|New relationship|Edit page|Resume save|Retry Git/}).count(),0);
  assert.equal(await page.getByRole('button',{name:'Recent',exact:true}).getAttribute('aria-pressed'),'true');
  await page.screenshot({animations:"disabled",path:base+'/recent-desktop.png'});
  await page.getByRole('button',{name:'Browse',exact:true}).click();
  await page.locator('.knowledge-table').waitFor();
  assert.ok((await page.locator('.knowledge-pagination').innerText()).includes('complete inventory'));
  await page.screenshot({animations:"disabled",path:base+'/browse-desktop.png'});
  await page.getByRole('button',{name:'Northwind launch',exact:true}).click();
  await page.locator('.knowledge-claim[data-kind=commitment]').waitFor();
  assert.equal(await page.locator('.knowledge-claim').count(),3);
  await page.getByText('Agent inferred',{exact:true}).waitFor();
  await page.locator('.knowledge-claim[data-kind=belief]').locator('summary').filter({hasText:'Evidence · 1 source files'}).click();
  await page.getByText('This is the agent’s inference, not a quoted source statement. Supporting material, if any, is shown below.',{exact:true}).waitFor();
  await page.locator('.knowledge-claim[data-kind=commitment]').locator('summary').filter({hasText:'Evidence · 1 source files'}).click();
  await page.evaluate(()=>{window.showSaveFilePicker=undefined});
  const downloaded=page.waitForEvent('download');
  await page.locator('.knowledge-claim[data-kind=commitment]').getByRole('button',{name:'Download original'}).click();
  const download=await downloaded;
  assert.equal((await fs.readFile(await download.path(),'utf8')),'Alex will deliver on Friday.\nLaunch happened yesterday.');
  await page.locator('.knowledge-claim details[open] > summary').evaluateAll(nodes=>nodes.forEach(node=>node.click()));
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.screenshot({animations:"disabled",path:base+'/entity-desktop.png',fullPage:true});
  await page.locator('.knowledge-claim[data-kind=commitment]').locator('summary').filter({hasText:'Evidence · 1 source files'}).click();
  await page.locator('.knowledge-claim[data-kind=commitment]').getByRole('button',{name:'Correct in chat'}).click();
  const prompt=await page.getByLabel('Chat request').inputValue();
  assert.match(prompt,/Observed revision: 1/);assert.match(prompt,/Observed SHA-256: [a-f0-9]{64}/);
  await page.clock.runFor(30001);
  assert.equal(await page.getByLabel('Chat request').inputValue(),prompt,'Passive refresh preserves the unsent handoff');
  await page.getByRole('button',{name:'Open chat',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>window.openedChat),{sessionKey:'new-chat',agentId:'main'});
  assert.equal(await page.evaluate(()=>window.createdChat.agentId),'main');
  await page.getByRole('button',{name:'Dismiss',exact:true}).click();
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({animations:"disabled",path:base+'/entity-mobile.png'});
  await page.getByRole('button',{name:'← Knowledge',exact:true}).click();
  await page.locator('.knowledge-table').waitFor();
  await page.getByLabel('Search knowledge').fill('Alex');
  await page.clock.runFor(250);
  await page.locator('.knowledge-suggestions').getByRole('button',{name:'Alex Rivera'}).waitFor();
  cappedSearch=true;
  await page.getByLabel('Search knowledge').fill('launch');
  await page.getByRole('button',{name:'Search all text',exact:true}).click();
  await page.getByText(/Ranked text search, not a complete inventory/).waitFor();
  assert.equal(await page.getByRole('button',{name:'Next',exact:true}).isDisabled(),true);
  await page.getByText(/cannot page beyond 520 search results/).waitFor();
  cappedSearch=false;
  await page.evaluate(()=>window.connect(false));
  await page.locator('.knowledge-status').getByText('Disconnected',{exact:true}).waitFor();
  await page.evaluate(()=>window.connect(true));
  await page.getByText(/Ranked text search, not a complete inventory/).waitFor();
  // Agent/service lifecycle operations refresh the read-only UI without browser writes.
  await page.getByRole('button',{name:'Browse',exact:true}).click();
  await page.getByRole('button',{name:'Northwind launch',exact:true}).click();
  await page.locator('.knowledge-claim[data-kind=commitment]').waitFor();
  const corrected=await service.correct({requestId:randomUUID(),id:commitment.id,expectedRevision:commitment.revision,expectedHash:commitment.hash,expectedOntologyFingerprint:fingerprint,reason:'The delivery date was corrected in chat.',replacement:{kind:'claim',title:'Updated release commitment',body:'Alex will deliver on Monday.',claim_kind:'commitment',assertion_origin:'user_belief',attribution:'User correction in chat',evidence,entities:[project.id],owner:person.id,due_at:'2026-09-28'}},agentContext);
  await page.evaluate(()=>window.emit('changed',{}));
  await page.getByRole('button',{name:'Alex will deliver on Monday.',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Alex will deliver on Friday.',exact:true}).count(),0);
  await page.getByRole('button',{name:'Alex will deliver on Monday.',exact:true}).click();
  await page.getByRole('button',{name:'View original assertion',exact:true}).click();
  await page.getByText('The delivery date was corrected in chat.',{exact:true}).waitFor();
  await page.getByText(/superseded — historical knowledge/).waitFor();
  await page.getByRole('button',{name:'View replacement →',exact:true}).click();
  await page.getByRole('heading',{name:'Updated release commitment',exact:true}).waitFor();
  await service.withdraw({requestId:randomUUID(),id:inference.id,expectedRevision:inference.revision,expectedHash:inference.hash,reason:'The readiness inference was withdrawn in chat.'},agentContext);
  // Freeze live notifications while capturing a stable visual state.
  await page.evaluate(()=>{window.emit=()=>{}});
  await page.getByRole('button',{name:'Browse',exact:true}).click();
  await page.getByRole('button',{name:'Northwind launch',exact:true}).click();
  await page.getByRole('button',{name:'Alex will deliver on Monday.',exact:true}).waitFor();
  await page.getByRole('button',{name:'Relationship evidence',exact:true}).waitFor();
  assert.equal(await page.locator('.knowledge-claim').count(),2);
  assert.equal(await page.locator('.knowledge-claim[data-kind=belief]').count(),0);
  // Dark screenshots use the supplied design tokens/fonts when KNOWLEDGE_DESIGN_ROOT is set.
  const designRoot=process.env.KNOWLEDGE_DESIGN_ROOT;
  let dark=':root{--bg:#0e1015;--card:#161920;--bg-hover:#1f2330;--bg-accent:#13151b;--text:#bcbcc0;--text-strong:#f4f4f5;--muted:#8b8b94;--muted-strong:#898990;--border:#1e2028;--accent:#ff5c5c;--accent-subtle:rgba(255,92,92,.1);--danger:#f87171;--warn:#f59e0b;--font-body:"Instrument Sans",system-ui;color-scheme:dark}body{font-family:var(--font-body)}';
  if(designRoot){
    dark+=await fs.readFile(designRoot+'/tokens/colors.css','utf8')+await fs.readFile(designRoot+'/tokens/typography.css','utf8')+await fs.readFile(designRoot+'/tokens/spacing.css','utf8');
    for(const [family,file] of [['Instrument Sans','instrument-sans-latin.woff2'],['JetBrains Mono','jetbrains-mono-latin.woff2']]) dark+=`@font-face{font-family:'${family}';src:url(data:font/woff2;base64,${(await fs.readFile(designRoot+'/assets/fonts/'+file)).toString('base64')}) format('woff2');font-weight:100 900;font-style:normal;font-display:block}`;
  }
  const hostRoot=process.env.KNOWLEDGE_HOST_UI_ROOT;
  if(hostRoot) {
    const hostHtml=await fs.readFile(hostRoot+'/index.html','utf8');
    const asset=hostHtml.match(/rel="stylesheet"[^>]*href="\.\/([^"]+)"/)[1];
    const hostCss=await fs.readFile(hostRoot+'/'+asset,'utf8');
    await page.addStyleTag({content:hostCss+'\n'+await fs.readFile('src/control-ui.css','utf8')});
    await page.evaluate(()=>{document.documentElement.dataset.theme='dark';document.documentElement.dataset.themeMode='dark';});
  }
  await page.addStyleTag({content:dark+'main{padding:16px 20px 32px}@media(max-width:650px){main{padding:0}}'});
  await page.evaluate(()=>document.fonts.ready); await page.setViewportSize({width:1182,height:900}); await page.evaluate(()=>window.scrollTo(0,0)); await page.clock.runFor(200);
  const geometry=await page.evaluate(()=>{ const bounds=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}};return {header:bounds('.knowledge-header'),tabs:bounds('.knowledge-tabs'),title:bounds('.knowledge-header h1'),body:bounds('.knowledge-page-body'),entityIcon:bounds('.knowledge-entity-header > .knowledge-tile'),aside:bounds('.knowledge-entity-aside'),claim:bounds('.knowledge-claim-row')}; });
  assert.equal(geometry.body.width,1120,'Reference content width');
  assert.equal(geometry.aside.width,300,'Reference entity sidebar width');
  assert.equal(geometry.entityIcon.width,48,'Reference entity tile size');
  assert.ok(geometry.claim.height<90,'Claims use compact disclosure rows');
  assert.ok(geometry.tabs.y < geometry.header.y+geometry.header.height,'Tabs share the desktop header');
  await fs.writeFile(base+'/visual-metrics.json',JSON.stringify(geometry,null,2));
  await page.getByRole('button',{name:'Alex will deliver on Monday.',exact:true}).waitFor();
  assert.equal(await page.locator('.knowledge-page').count(),1);
  await page.screenshot({animations:"disabled",path:base+'/entity-dark-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844}); assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false); await page.clock.runFor(200); await page.screenshot({animations:"disabled",path:base+'/entity-dark-mobile.png'});
  await page.setViewportSize({width:1182,height:900});
  await page.getByRole('button',{name:'Browse',exact:true}).click(); await page.locator('.knowledge-table').waitFor();
  assert.equal(await page.locator('.knowledge-table .knowledge-tile svg').count(),3);
  await page.getByLabel('Search knowledge').fill('');
  await page.clock.runFor(200); await page.screenshot({animations:"disabled",path:base+'/browse-dark-desktop.png'});
  for(const width of [760,390]) { await page.setViewportSize({width,height:900}); assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`Browse does not overflow at ${width}px`); await page.screenshot({animations:"disabled",path:base+`/browse-dark-${width}.png`}); }
  await page.setViewportSize({width:1182,height:900});
  await page.keyboard.press('/'); assert.equal(await page.getByLabel('Search knowledge').evaluate(n=>document.activeElement===n),true);
  await page.getByLabel('Search knowledge').fill('');
  await page.getByRole('button',{name:'Recent',exact:true}).click();
  await page.locator('.knowledge-historical-notice').filter({hasText:'Current status: withdrawn'}).first().waitFor();
  assert.equal(await page.locator('.knowledge-feed').getByText('Readiness inference',{exact:true}).count(),0);
  assert.equal(await page.locator('.knowledge-feed').getByText('Release commitment',{exact:true}).count(),0);
  await page.setViewportSize({width:1182,height:900}); await page.clock.runFor(200); await page.screenshot({animations:"disabled",path:base+'/recent-dark-desktop.png',fullPage:true});
  const searchGap=await page.evaluate(()=>document.querySelector('.knowledge-feed').getBoundingClientRect().top-document.querySelector('.knowledge-search input').getBoundingClientRect().bottom); assert.equal(searchGap,28,'Host form margins must not change reference section spacing');
  // Test the real host's light-mode cascade, not just alternate color tokens.
  for (const mode of ['light','dark']) {
    await page.evaluate(mode=>{document.documentElement.dataset.theme=mode;document.documentElement.dataset.themeMode=mode;},mode);
    for (const name of ['Browse','Recent']) {
      const tab=page.locator('.knowledge-tabs').getByRole('button',{name,exact:true});
      await tab.hover(); await tab.click();
      await page.locator(name==='Browse'?'.knowledge-table':'.knowledge-feed').waitFor();
      await page.clock.runFor(200);
      const styles=await page.locator('.knowledge-tabs button').evaluateAll(nodes=>nodes.map(n=>{const s=getComputedStyle(n);return {background:s.backgroundColor,border:s.borderTopWidth,shadow:s.boxShadow};}));
      for(const style of styles) { assert.equal(style.background,'rgba(0, 0, 0, 0)',`${mode} tabs remain unfilled, including hover/selection`); assert.equal(style.border,'0px'); assert.equal(style.shadow,'none'); }
    }
    await page.mouse.move(0,0); await page.clock.runFor(200);
    await page.locator('.knowledge-header').screenshot({animations:'disabled',path:base+`/tabs-${mode}.png`});
  }
  await page.locator('.knowledge-historical-notice').filter({hasText:'Current status: withdrawn'}).first().getByRole('button',{name:'Inspect historical record'}).click();
  await page.getByText('The readiness inference was withdrawn in chat.',{exact:true}).waitFor();
  await page.getByText(/withdrawn — historical knowledge/).waitFor();
  await page.getByRole('button',{name:'Vocabulary',exact:true}).click();
  await page.locator('.knowledge-ontology-layout').waitFor();
  await page.evaluate(()=>window.remount());
  await page.locator('.knowledge-feed').waitFor();
  assert.deepEqual(await page.evaluate(()=>window.subscriptions()),{events:1,connections:1});
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:['light/dark text-tab styling under the production host cascade','reference layout measurements and type icons','search keyboard shortcut','read-only browser contract','agent correction live refresh and historical linkage','withdrawal removes active claims and redacts historical feed titles','search offset cap','design-token dark screenshots','recent default and observed history','ontology-derived browse','native commitment/event/inference cards','attribution and retained inference premise evidence','byte-exact evidence download','revision/hash chat request and no autosend','handoff preserved across periodic refresh','exact name suggestions','ranked search','disconnect and reconnect','subscription cleanup','mobile overflow','no page errors'],artifacts:base},null,2));
} catch (error) {
  console.error(JSON.stringify({errors,page:await page?.locator('main').innerText()},null,2));throw error;
} finally {services.forEach(s=>s.stop());await browser.close();}
