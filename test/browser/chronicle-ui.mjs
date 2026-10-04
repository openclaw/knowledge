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
let snapshot = "fixture-a", page, held;
const at = "2026-10-04T12:00:00Z";
const item = n => ({ record: { id: `event-${n}`, title: `Event ${n}`, path: `claims/event-${n}.md`, kind: "claim", type: "event", revision: 1, hash: "a".repeat(64) }, date: "2026-10-04", dateField: "occurred_at", precision: "day", summary: `Fixture summary ${n}`, entities: ["person-1"], sourcePage: "source-1", evidenceCount: 1 });
try {
  page = await browser.newPage({ viewport: { width: 1100, height: 900 } }); page.setDefaultTimeout(10000);
  page.on("pageerror", error => errors.push(error.message));
  await page.exposeFunction("invokeKnowledge", async (op, input) => {
    if (op === "agent_query") { op = input.operation; input = input.input; }
    requests.push({ op, input });
    if (op === "stores_snapshot") throw Error("Fixture uses default viewing context");
    if (op === "status") return { service: "knowledge", phase: "structured-writes", backendRevision: "fixture", instanceId: "fixture", startedAt: at, checkedAt: at, snapshot, vault: "vault-1", agent: "main", store: "ready", scope: "owner", writesEnabled: false, live: "stopped", records: 3, validRecords: 3, definitions: 0, ontologyAvailable: true, ontologyFingerprint: "fixture", issues: 0 };
    if (op === "ontology") return { view: "catalog", available: true, name: "fixture", version: "1", fingerprint: "fixture", total: 0, offset: 0, nextOffset: null, definitions: [], totalIssues: 0 };
    if (op === "timeline") {
      if (held) { const pending = held; held = undefined; pending.started(); await pending.gate; }
      if (input.snapshot && input.snapshot !== snapshot) throw Error("Knowledge changed; restart temporal pagination without offset or snapshot.");
      const offset = input.offset ?? 0;
      return { items: [item(offset + 1)], total: 3, offset, nextOffset: offset < 2 ? offset + 1 : null, snapshot, checkedAt: at, coverage: { complete: false, message: "Structured dated records only; fixture coverage is partial." } };
    }
    if (op === "record") throw Error("Fixture record inspection reached");
    if (op === "lookup") return { hits: [], resultCount: 0, offset: 0, nextOffset: null, checkedAt: at, coverage: { complete: true, message: "" }, total: 0, outcome: "missing" };
    if (op === "grep") return { hits: [], resultCount: 0, offset: 0, nextOffset: null, checkedAt: at, coverage: { complete: true, message: "" }, total: 0, mode: "keyword", queryMode: "all", index: { state: "ready", lag: false, snapshot, indexedAt: at, message: "" } };
    throw Error(`Unexpected UI operation: ${op}`);
  });
  await page.route("https://knowledge.test/**", route => route.fulfill({ contentType: "text/html", body: html }));
  const url = "https://knowledge.test/plugin?plugin=knowledge&id=overview&p.view=timeline&p.since=2026-10-01&p.entity=person-1";
  await page.goto(url);
  await page.getByRole("button", { name: "Event 1", exact: true }).waitFor();
  assert.match(await page.locator(".knowledge-timeline").innerText(), /Partial coverage.*Structured dated records/);
  assert.match(await page.locator(".knowledge-timeline-row").innerText(), /date only/);
  assert.equal(new URL(page.url()).searchParams.get("p.snapshot"), snapshot);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("button", { name: "Event 2", exact: true }).waitFor();
  assert.equal(requests.filter(r => r.op === "timeline").at(-1).input.offset, 1);
  assert.equal(requests.filter(r => r.op === "timeline").at(-1).input.snapshot, snapshot);
  await page.reload(); await page.getByRole("button", { name: "Event 2", exact: true }).waitFor();
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await page.getByRole("button", { name: "Event 1", exact: true }).waitFor();
  checks.push("snapshot, returned short-page offsets and previous trail survive reload");
  await page.getByLabel("Until (inclusive)").fill("2026-10-09");
  const previousReads = requests.filter(r => r.op === "status").length;
  let refreshed; const refreshedRead = new Promise(resolve => refreshed = resolve);
  await page.exposeFunction("refreshObserved", refreshed);
  await page.evaluate(() => { const invoke = window.invokeKnowledge; window.invokeKnowledge = async (op, input) => { const result = await invoke(op, input); if (op === "status" || (op === "agent_query" && input.operation === "status")) window.refreshObserved(); return result; }; window.changed(); });
  await refreshedRead;
  assert.equal(await page.getByLabel("Until (inclusive)").inputValue(), "2026-10-09");
  assert.ok(requests.filter(r => r.op === "status").length > previousReads);
  await page.getByLabel("Until (inclusive)").fill("");
  checks.push("existing refresh lifecycle preserves unsubmitted filter edits");
  await page.getByRole("button", { name: "Open source page", exact: true }).click();
  await page.getByText("Fixture record inspection reached", { exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("p.record"), "source-1");
  assert.equal(requests.filter(r => r.op === "record").at(-1).input.id, "source-1");
  await page.goBack(); await page.getByRole("button", { name: "Event 1", exact: true }).waitFor();
  checks.push("source rows address exact records and browser Back restores timeline");
  await page.getByLabel("Since (inclusive)").fill("yesterday");
  const before = requests.filter(r => r.op === "timeline").length;
  await page.getByRole("button", { name: "Apply filters", exact: true }).click();
  await page.getByText(/Since must be a real/).waitFor();
  assert.equal(requests.filter(r => r.op === "timeline").length, before);
  await page.getByLabel("Since (inclusive)").fill("2026-10-03");
  await page.getByLabel("Date field").selectOption("due_at");
  await page.getByRole("button", { name: "Apply filters", exact: true }).click();
  await page.waitForFunction(() => new URL(location.href).searchParams.get("p.timeField") === "due_at");
  await page.getByRole("button", { name: "Event 1", exact: true }).waitFor();
  const filtered = requests.filter(r => r.op === "timeline").at(-1).input;
  assert.deepEqual({ since: filtered.since, entity: filtered.entity, timeField: filtered.timeField, snapshot: filtered.snapshot, offset: filtered.offset }, { since: "2026-10-03", entity: "person-1", timeField: "due_at", snapshot: undefined, offset: 0 });
  checks.push("explicit date validation and filter changes reset snapshot pagination");
  snapshot = "fixture-b"; await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("button", { name: "Restart timeline", exact: true }).waitFor();
  assert.equal(await page.locator(".knowledge-timeline-row").count(), 0);
  await page.getByRole("button", { name: "Restart timeline", exact: true }).click();
  await page.getByRole("button", { name: "Event 1", exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("p.snapshot"), snapshot);
  checks.push("changed snapshots never mix rows and offer explicit restart");
  let release, started; const gate = new Promise(resolve => release = resolve), entered = new Promise(resolve => started = resolve);
  held = { gate, started };
  await page.getByRole("button", { name: "Next", exact: true }).click(); await entered;
  await page.goBack(); await page.getByRole("button", { name: "Event 1", exact: true }).waitFor();
  release();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("button", { name: "Event 2", exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("p.offset"), "1");
  checks.push("late timeline responses cannot overwrite browser history navigation");
  await page.goto("https://knowledge.test/plugin?plugin=knowledge&id=overview&p.view=search&p.q=launch&p.since=2026-10-01&p.timeField=recorded_at");
  await page.getByText("No matches", { exact: true }).waitFor();
  assert.equal(requests.filter(r => r.op === "grep").at(-1).input.since, "2026-10-01");
  await page.getByLabel("Until (inclusive)").fill("2026-10-04T12:00:00Z");
  await page.getByRole("button", { name: "Apply dates", exact: true }).click();
  await page.waitForFunction(() => new URL(location.href).searchParams.get("p.until") === "2026-10-04T12:00:00Z");
  await page.getByText("No matches", { exact: true }).waitFor();
  assert.equal(requests.filter(r => r.op === "grep").at(-1).input.until, "2026-10-04T12:00:00Z");
  checks.push("text search sends the same explicit date predicates");
  await page.goto(url + "&p.offset=40");
  await page.getByText("Timeline snapshot missing", { exact: true }).waitFor();
  checks.push("unfenced deep-link offsets require restart");
  assert.deepEqual(errors, []); console.log(JSON.stringify({ checks }, null, 2));
} catch (error) { console.error({ requests, errors, text: await page?.locator("body").innerText() }); throw error; } finally { await browser.close(); }
