// UI-only fixture transport: no service, store, writes, or watcher is started.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { build } from "esbuild";
const require = createRequire(import.meta.url);
const { chromium } = require(await fs.realpath("node_modules/openclaw") + "/node_modules/playwright");
const entry = `import plugin from "./src/control-ui.ts";
let handle,view;const signal=new AbortController().signal;const events=new Map();
const props=()=>Object.fromEntries([...new URLSearchParams(location.search)].filter(([k])=>k.startsWith("p.")).map(([k,v])=>[k.slice(2),v]));
const context=()=>({host,signal,props:props()});
const host={pluginId:"knowledge",signal,connection:{connected:true},redact:String,
request:async(method,p)=>{try{return{ok:true,result:await window.invokeKnowledge(p.actionId,p.payload)}}catch(e){return{ok:false,error:String(e.message||e)}}},
onEvent:(name,fn)=>{events.set(name,fn);return()=>events.delete(name)},subscribe:()=>()=>{},agents:{rows:[{id:"main",name:"Main"}],selectedId:"main"},
navigation:{openPage:({id,params},options)=>{const url=new URL("/plugin?plugin=knowledge&id="+id,location.origin);for(const[k,v]of Object.entries(params))url.searchParams.set("p."+k,v);history[options?.replace?"replaceState":"pushState"](null,"",url);queueMicrotask(()=>handle?.update(context()));}},
ui:{registerNavigation:()=>()=>{},registerPage:page=>{view=page;return()=>{}}}};
window.changed=()=>events.get("plugin.knowledge.changed")?.({});
plugin.activate(host);handle=view.mount(document.querySelector("main"),context());window.addEventListener("popstate",()=>handle.update(context()));`;
const bundle = await build({ stdin: { contents: entry, resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", loader: { ".css": "empty" } });
const html = `<style>:root{--text:#222;--muted:#555;--border:#ccc;--card:white;--bg:white;--accent:green}${await fs.readFile("src/control-ui.css", "utf8")}</style><main></main><script>${bundle.outputFiles[0].text}</script>`;
const browser = await chromium.launch({ headless: true, ...(process.env.KNOWLEDGE_BROWSER_PATH ? { executablePath: process.env.KNOWLEDGE_BROWSER_PATH } : {}) });
const requests = [], errors = [], checks = [];
const snapshot = "fixture-a"; let page;
const at = "2026-10-04T12:00:00Z";
try {
  page = await browser.newPage({ viewport: { width: 1100, height: 900 } }); page.setDefaultTimeout(10000);
  page.on("pageerror", error => errors.push(error.message));
  await page.exposeFunction("invokeKnowledge", async (op, input) => {
    if (op === "agent_query") { op = input.operation; input = input.input; }
    requests.push({ op, input });
    if (op === "stores_snapshot") throw Error("Fixture uses default viewing context");
    if (op === "status") return { service: "knowledge", phase: "structured-writes", backendRevision: "fixture", instanceId: "fixture", startedAt: at, checkedAt: at, snapshot, vault: "vault-1", agent: "main", store: "ready", scope: "owner", writesEnabled: false, live: "stopped", records: 3, validRecords: 3, definitions: 0, ontologyAvailable: true, ontologyFingerprint: "fixture", issues: 0 };
    if (op === "ontology") return { view: "catalog", available: true, name: "fixture", version: "1", fingerprint: "fixture", total: 0, offset: 0, nextOffset: null, definitions: [], totalIssues: 0 };
    if (op === "record") throw Error("Fixture record inspection reached");
    if (op === "lookup") return { hits: [], resultCount: 0, offset: 0, nextOffset: null, checkedAt: at, coverage: { complete: true, message: "" }, total: 0, outcome: "missing" };
    if (op === "grep") return { hits: [], resultCount: 0, offset: 0, nextOffset: null, checkedAt: at, coverage: { complete: true, message: "" }, total: 0, mode: "keyword", queryMode: "all", index: { state: "ready", lag: false, snapshot, indexedAt: at, message: "" } };
    throw Error(`Unexpected UI operation: ${op}`);
  });
  await page.route("https://knowledge.test/**", route => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto("https://knowledge.test/plugin?plugin=knowledge&id=overview&p.view=search&p.q=launch&p.since=2026-10-01&p.timeField=recorded_at");
  await page.getByText("No matches", { exact: true }).waitFor();
  assert.equal(requests.filter(r => r.op === "grep").at(-1).input.since, "2026-10-01");
  await page.getByLabel("Until (inclusive)").fill("2026-10-04T12:00:00Z");
  await page.getByRole("button", { name: "Apply dates", exact: true }).click();
  await page.waitForFunction(() => new URL(location.href).searchParams.get("p.until") === "2026-10-04T12:00:00Z");
  await page.getByText("No matches", { exact: true }).waitFor();
  assert.equal(requests.filter(r => r.op === "grep").at(-1).input.until, "2026-10-04T12:00:00Z");
  checks.push("text search sends the same explicit date predicates");
  assert.equal(await page.getByRole("button", { name: "Timeline", exact: true }).count(), 0);
  assert.equal(await page.locator(".knowledge-timeline").count(), 0);
  assert.equal(requests.filter(r => r.op === "timeline").length, 0);
  checks.push("navigation contains no standalone Timeline view or requests");
  await page.getByLabel("Since (inclusive)").fill("yesterday");
  const before = requests.filter(r => r.op === "grep").length;
  await page.getByRole("button", { name: "Apply dates", exact: true }).click();
  await page.getByText(/Since must be a real/).waitFor();
  assert.equal(requests.filter(r => r.op === "grep").length, before);
  checks.push("invalid search dates fail before querying");
  await page.reload(); await page.getByText("No matches", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Until (inclusive)").inputValue(), "2026-10-04T12:00:00Z");
  checks.push("search date filters survive reload");
  assert.deepEqual(errors, []); console.log(JSON.stringify({ checks }, null, 2));
} catch (error) { console.error({ requests, errors, text: await page?.locator("body").innerText() }); throw error; } finally { await browser.close(); }
