import { defineControlUiPlugin } from "openclaw/plugin-sdk/control-ui";
import { createFeatureClient, type FeatureOutput } from "openclaw/plugin-sdk/feature-contract";
import { contract } from "./contract.js";
import "./control-ui.css";
import { ontologyView } from "./ontology-view.js";

type Summary = FeatureOutput<typeof contract, "records">["records"][number];
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) {
  const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node;
}
function button(label: string, action: () => void) { const node = el("button", label); node.type = "button"; node.onclick = action; return node; }
function rawBlock(label: string, text: string, open = false) { const node = el("details"); node.open = open; node.append(el("summary", label), el("pre", text)); return node; }
function issueList(issues: { path: string; code: string; message: string }[]) {
  const list = el("ul", undefined, "knowledge-issues");
  for (const issue of issues) { const item = el("li"); item.append(el("strong", issue.code.replaceAll("-", " ")), el("code", issue.path), el("p", issue.message)); list.append(item); }
  return list;
}
export default defineControlUiPlugin({
  id: contract.pluginId,
  activate(host) {
    const removeNavigation = host.ui.registerNavigation({ id: "knowledge", label: "Knowledge", page: { id: "overview" }, icon: "bookOpen" });
    const removePage = host.ui.registerPage({
      id: "overview", label: "Knowledge",
      mount(container, context) {
        const feature = createFeatureClient(contract, context.host), section = el("section", undefined, "knowledge-page");
        const header = el("header"), eyebrow = el("p", "KNOWLEDGE / EXPLORER", "knowledge-eyebrow");
        header.append(eyebrow, el("h1", "A clearer view of what you know."), el("p", "Browse records, follow their evidence, and inspect the definitions behind them."));
        const banner = el("div", undefined, "knowledge-banner");
        banner.append(el("strong", "Read only"), el("p", "Checking the connected vault…"));
        const status = el("div", "Loading vault…", "knowledge-status"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
        const nav = el("nav", undefined, "knowledge-tabs"); nav.setAttribute("aria-label", "Knowledge views");
        const toolbar = el("div", undefined, "knowledge-toolbar"), content = el("div", undefined, "knowledge-content");
        section.append(header, banner, status, nav, toolbar, content); container.append(section);
        let tab: "records" | "ontology" | "diagnostics" = "records", offset = 0, query = "", kind = "", type = "", selectedId = "";
        let generation = 0, detailGeneration = 0, disposed = false, debounce: ReturnType<typeof setTimeout> | undefined;
        const alive = (n: number) => !disposed && !context.signal.aborted && n === generation && context.host.connection.connected;
        const showError = (error: unknown) => { content.replaceChildren(el("p", "Knowledge unavailable: " + context.host.redact(error instanceof Error ? error.message : String(error)), "knowledge-error")); };
        const tabs = new Map<string, HTMLButtonElement>();
        for (const [key, label] of [["records", "Records"], ["ontology", "Ontology"], ["diagnostics", "Activity & issues"]] as const) {
          const control = button(label, () => { tab = key; selectedId = ""; clearTimeout(debounce); renderToolbar(); void load(); }); tabs.set(key, control); nav.append(control);
        }
        function renderToolbar() {
          for (const [key, control] of tabs) control.setAttribute("aria-pressed", String(tab === key));
          toolbar.replaceChildren();
          if (tab === "records") {
            const search = el("input"); search.type = "search"; search.placeholder = "Find by name, alias, or ID"; search.value = query; search.setAttribute("aria-label", "Filter records by name, alias, or ID");
            search.oninput = () => { query = search.value; offset = 0; selectedId = ""; clearTimeout(debounce); debounce = setTimeout(() => void load(), 200); };
            const select = el("select"); select.setAttribute("aria-label", "Record kind");
            for (const [value,label] of [["", "All record kinds"], ["page", "Pages"], ["claim", "Claims"], ["relationship", "Relationships"]]) { const option = el("option", label); option.value = value; select.append(option); }
            select.value = kind; select.onchange = () => { kind = select.value; offset = 0; selectedId = ""; void load(); };
            const typeFilter = el("input"); typeFilter.placeholder = "Type or ontology alias"; typeFilter.value = type; typeFilter.setAttribute("aria-label", "Filter by type or ontology alias");
            typeFilter.oninput = () => { type = typeFilter.value.trim(); offset = 0; selectedId = ""; clearTimeout(debounce); debounce = setTimeout(() => void load(), 200); };
            toolbar.append(search, select, typeFilter);
          }
          toolbar.hidden = tab !== "records";
        }
        async function showDetail(id: string, target: HTMLElement, n: number) {
          const detail = ++detailGeneration; selectedId = id; target.replaceChildren(el("p", "Loading record…"));
          try {
            const result = await feature.invoke("record", { id });
            if (!alive(n) || detail !== detailGeneration) return;
            target.replaceChildren();
            if (!result.record) { target.append(el("h2", "Record unavailable"), el("p", "This ID is missing or duplicated. Inspect Activity & issues; no file was selected arbitrarily.")); return; }
            const r = result.record;
            target.append(el("p", `${r.kind} / ${r.type}`, "knowledge-eyebrow"), el("h2", r.title), el("p", `${r.acceptance} · ${r.lifecycle} · Revision ${r.revision}`, "knowledge-muted"), el("code", r.path));
            if (!r.valid) target.append(el("p", "Validation issues — this record is not fully valid.", "knowledge-error"));
            target.append(el("h3", "Authored Markdown"), el("pre", r.body, "knowledge-body"));
            if (result.evidence.length) {
              target.append(el("h3", "Evidence"));
              for (const e of result.evidence) {
                const evidence = el("article", undefined, "knowledge-evidence");
                evidence.append(el("strong", e.verified ? "Verified source" : "Source could not be verified"), el("p", `${e.path} · Lines ${e.start_line}–${e.end_line}`), el("blockquote", e.excerpt || "No verified excerpt available."), rawBlock("Content hash", e.sha256)); target.append(evidence);
              }
            }
            if (result.references.length) {
              target.append(el("h3", "Connected records"));
              const links = el("div", undefined, "knowledge-references");
              for (const ref of result.references) links.append(button(`${ref.title} · ${ref.kind}`, () => void showDetail(ref.id, target, n)));
              target.append(links);
            }
            if (result.issues.length) target.append(issueList(result.issues));
            target.append(rawBlock("Structured fields & metadata", r.metadata), rawBlock("Original file (read only)", r.raw), rawBlock("Identity & observed content hash", `${r.id}\nSHA-256: ${r.hash}`));
          } catch (error) { if (alive(n) && detail === detailGeneration) target.replaceChildren(el("p", context.host.redact(error instanceof Error ? error.message : String(error)), "knowledge-error")); }
        }
        function recordButton(record: Summary, detail: HTMLElement, n: number) {
          const control = button("", () => { for (const other of content.querySelectorAll(".knowledge-record")) other.setAttribute("aria-pressed", "false"); control.setAttribute("aria-pressed", "true"); void showDetail(record.id, detail, n); });
          control.className = "knowledge-record"; control.setAttribute("aria-pressed", String(record.id === selectedId));
          control.append(el("strong", record.title), el("span", `${record.kind} · ${record.type}`), el("small", record.valid ? `${record.acceptance} · ${record.lifecycle}` : "Needs attention")); return control;
        }
        async function load() {
          const n = ++generation; ++detailGeneration;
          content.replaceChildren(el("p", context.host.connection.connected ? "Loading…" : "Disconnected — reconnect to read the vault."));
          if (!context.host.connection.connected) return;
          try {
            if (tab === "records") {
              const result = await feature.invoke("records", { offset, limit: 50, ...(query ? { query } : {}), ...(type ? { type } : {}), ...(kind ? { kind: kind as "page" | "claim" | "relationship" } : {}) });
              if (!alive(n)) return;
              content.replaceChildren(el("p", result.total ? `${result.total} records${result.nextOffset !== null || offset ? ` · Showing ${offset + 1}–${offset + result.records.length}` : ""}` : "No matching records.", "knowledge-muted"));
              const split = el("div", undefined, "knowledge-split"), list = el("div", undefined, "knowledge-records"), detail = el("article", undefined, "knowledge-detail");
              detail.append(el("h2", "Inspect a record"), el("p", "Select a record to see its authored text, structured fields, evidence, and connections."));
              for (const record of result.records) list.append(recordButton(record, detail, n));
              split.append(list, detail); content.append(split);
              const pages = el("div", undefined, "knowledge-pagination");
              if (offset) pages.append(button("Previous", () => { offset = Math.max(0, offset - 50); void load(); }));
              if (result.nextOffset !== null) pages.append(button("Next", () => { offset = result.nextOffset!; void load(); }));
              content.append(pages);
              if (selectedId) void showDetail(selectedId, detail, n);
            } else if (tab === "ontology") {
              const result = await feature.invoke("ontology", {}); if (!alive(n)) return;
              content.replaceChildren(ontologyView(result, id => {
                tab = "records"; selectedId = id; offset = 0; query = ""; kind = ""; type = ""; renderToolbar(); void load();
              }, () => { tab = "diagnostics"; renderToolbar(); void load(); }));

            } else {
              const result = await feature.invoke("diagnostics", {}); if (!alive(n)) return;
              content.replaceChildren(el("h2", "Activity & issues"), el("p", "Current validation findings for this scope, not a mutation history. No repairs or writes have occurred."), el("p", `${result.total} findings · Checked ${new Date(result.checkedAt).toLocaleTimeString()}${result.truncated ? " · First 1,000 shown" : ""}`));
              content.append(result.issues.length ? issueList(result.issues) : el("p", "No validation issues found."));
            }
          } catch (error) { if (alive(n)) showError(error); }
        }
        let statusGeneration = 0;
        async function refresh() {
          const n = ++statusGeneration;
          void load();
          if (!context.host.connection.connected) { status.textContent = "Disconnected — waiting for OpenClaw."; return; }
          status.textContent = "Checking vault…";
          try {
            const report = await feature.invoke("status", {});
            if (disposed || context.signal.aborted || n !== statusGeneration || !context.host.connection.connected) return;
            banner.replaceChildren(el("strong", report.sample ? "Sample vault · Read only" : `${report.agent} · Private vault · Read only`), el("p", report.sample ? "Fictional people and projects for exploring the data model. No private agent vault is connected." : "Your agent’s knowledge. Record writes are not enabled yet."));
            status.textContent = `${report.records} ${report.sample ? "sample " : ""}records${report.issues ? ` · ${report.issues} issues to review` : ""}`;
          } catch (error) { if (!disposed && n === statusGeneration) status.textContent = "Knowledge unavailable: " + context.host.redact(error instanceof Error ? error.message : String(error)); }
        }
        let connected = context.host.connection.connected;
        const unsubscribe = context.host.subscribe(() => { if (connected !== context.host.connection.connected) { connected = context.host.connection.connected; void refresh(); } });
        renderToolbar(); void refresh();
        return { dispose() { disposed = true; ++generation; ++detailGeneration; ++statusGeneration; clearTimeout(debounce); unsubscribe(); section.remove(); } };
      },
    });
    return () => { removePage(); removeNavigation(); };
  },
});
