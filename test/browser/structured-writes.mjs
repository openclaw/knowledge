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
const services=[]; let page, loseResponse=false, blockMutation=false;
const requests=[], errors=[];
const api={pluginConfig:{vault:{root:base+'/vault',statePath:base+'/state.sqlite',agentId:'main',vaultId:manifest.vaultId,publicationId:manifest.publicationId,operatorRead:true,writesEnabled:true}},registerService:s=>services.push(s)};
const service=createKnowledgeService(api,{emit:(event,payload)=>{void page?.evaluate(({event,payload})=>window.emit?.(event,payload),{event,payload}).catch(()=>{});}});
const context={source:'session-action',api,action:{client:{connId:'isolated-browser',scopes:['operator.write']}}};
const browser=await chromium.launch({headless:true,executablePath:process.env.KNOWLEDGE_BROWSER_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const entry=`import plugin from './src/control-ui.ts';
const listeners=new Set(), events=new Map(); let mounted, controller;
const host={pluginId:'knowledge',signal:new AbortController().signal,connection:{connected:true},redact:String,
 request:async(method,p)=>({ok:true,result:await window.invokeKnowledge(p.actionId,p.payload)}),
 onEvent:(name,fn)=>{events.set(name,fn);return()=>events.delete(name)},subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},
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
  page=await browser.newPage({viewport:{width:1280,height:1100}});
  page.setDefaultTimeout(10000);
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://knowledge.test/**',route=>route.fulfill({contentType:'text/html',body:html}));
  await page.exposeFunction('invokeKnowledge',async(operation,input)=>{
    if(operation==='mutation'&&blockMutation)throw Error('Disconnected before outcome known');
    if(operation.startsWith('create_'))requests.push({operation,input:structuredClone(input)});
    const result=await service[operation](input,context);
    if(operation.startsWith('create_')&&loseResponse){loseResponse=false;blockMutation=true;throw Error('Lost response after publication');}
    return result;
  });
  const records={};
  for(const type of ['person','project','meeting']) records[type]=await service.save_page({requestId:randomUUID(),title:type,type,body:'Structured fixture'},context);
  services[0].start();
  await page.goto('https://knowledge.test/');
  await page.getByRole('button',{name:'New claim',exact:true}).click();
  await page.getByLabel('Title',{exact:true}).fill('Release commitment');
  await page.getByLabel('Markdown',{exact:true}).fill('Alex will deliver on Friday.');
  await page.getByLabel('Claim kind',{exact:true}).selectOption('commitment');
  await page.getByLabel('Commitment owner',{exact:true}).selectOption(records.person.id);
  await page.getByLabel('Commitment due (date or timestamp with timezone)',{exact:true}).fill('2026-09-25');
  await page.getByLabel('About page IDs (one per line)',{exact:true}).fill(records.project.id);
  await page.getByLabel('Depends on record IDs (one per line)',{exact:true}).fill(records.meeting.id);
  await page.getByLabel('Assertion attribution (required)',{exact:true}).fill('Alex, meeting transcript');
  await page.reload();
  await page.getByRole('dialog').waitFor();
  assert.equal(await page.getByLabel('Commitment due (date or timestamp with timezone)',{exact:true}).inputValue(),'2026-09-25');
  await page.getByLabel('Attach source files (optional)',{exact:true}).setInputFiles({name:'meeting.txt',mimeType:'text/plain',buffer:Buffer.from('Alex will deliver on Friday.')});
  loseResponse=true;
  await page.getByRole('button',{name:'Save claim',exact:true}).click();
  await page.getByRole('button',{name:'Retry same save',exact:true}).waitFor();
  await page.reload();
  await page.getByRole('button',{name:'Retry same save',exact:true}).waitFor();
  assert.equal(await page.getByLabel('Commitment owner',{exact:true}).isDisabled(),true);
  blockMutation=false;
  await page.getByRole('button',{name:'Retry same save',exact:true}).click();
  await page.getByRole('dialog').waitFor({state:'detached'});
  assert.deepEqual(requests[0],requests[1]);
  const claims=await service.records({kind:'claim'},context);assert.equal(claims.total,1);
  const claim=await service.record({id:claims.records[0].id,includeMetadata:true},context);
  assert.equal(claim.record.metadata.owner,records.person.id);assert.equal(claim.record.metadata.due_at,'2026-09-25');
  await page.getByRole('heading',{name:'Assertion details',exact:true}).waitFor();
  await page.getByRole('button',{name:'New relationship',exact:true}).click();
  await page.getByLabel('Title',{exact:true}).fill('Alex leads the project');
  await page.getByLabel('Markdown',{exact:true}).fill('Alex is responsible for delivery.');
  await page.getByLabel('Relationship label',{exact:true}).selectOption('leads');
  await page.getByLabel('From page',{exact:true}).selectOption(records.person.id);
  await page.getByLabel('To page',{exact:true}).selectOption(records.project.id);
  await page.getByLabel('Assertion attribution (required)',{exact:true}).fill('Alex, transcript');
  const evidence=claim.record.metadata.evidence.map(e=>({...e,start_line:1,end_line:1,quote:'Alex will deliver on Friday.'}));
  await page.getByLabel('Existing evidence / exact locators (JSON array)',{exact:true}).fill(JSON.stringify(evidence));
  await page.reload();
  await page.getByLabel('From page',{exact:true}).selectOption(records.person.id);
  assert.equal(await page.getByLabel('Relationship label',{exact:true}).inputValue(),'leads');
  await page.getByRole('button',{name:'Save relationship',exact:true}).click();
  await page.getByRole('dialog').waitFor({state:'detached'});
  const edges=await service.connections({id:records.person.id,direction:'outgoing'},context);assert.equal(edges.total,1);assert.equal(edges.connections[0].label,'leads');
  // An agent/service-created event appears in the mounted browser through live refresh.
  const event=await service.create_claim({requestId:randomUUID(),expectedOntologyFingerprint:(await service.ontology({},context)).fingerprint,title:'Historical launch',body:'Launch occurred.',claim_kind:'event',assertion_origin:'source',attribution:'Historical source',occurred_at:'2020-02-29',evidence,entities:[records.project.id]},context);
  await page.locator('.knowledge-record').filter({hasText:'Historical launch'}).click();
  await page.locator('.knowledge-detail dd').filter({hasText:'2020-02-29'}).waitFor();
  // Native entity metadata edits read back through the same contract.
  await page.locator('.knowledge-record strong').getByText('person',{exact:true}).click();
  await page.getByRole('button',{name:'Edit page',exact:true}).click();
  await page.getByLabel('Aliases (one per line)',{exact:true}).fill('Alex');
  await page.getByLabel('Tags (one per line)',{exact:true}).fill('release-team');
  await page.getByRole('button',{name:'Save page',exact:true}).click();
  await page.getByRole('dialog').waitFor({state:'detached'});
  assert.equal((await service.lookup({query:'Alex'},context)).hits[0].record.id,records.person.id);
  await page.getByRole('heading',{name:'Active relationships, claims & dependents',exact:true}).waitFor();
  await page.screenshot({path:base+'/structured-desktop.png'});
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('button',{name:'New claim',exact:true}).click();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:base+'/structured-mobile.png'});
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:['native commitment creation','unsaved structured draft reload','lost-response exact replay after reload','native relationship creation and retained locators','agent-created event live refresh','entity metadata write/read parity','connection navigation','mobile overflow','no page errors'],artifacts:base},null,2));
} catch (error) {
  console.error(JSON.stringify({errors,page:await page?.locator('main').innerText()},null,2));throw error;
} finally {services.forEach(s=>s.stop());await browser.close();}
