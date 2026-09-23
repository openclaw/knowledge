import { evidenceView } from "./evidence-view.js";
import { defineControlUiPlugin } from "openclaw/plugin-sdk/control-ui";
import { createFeatureClient, type FeatureOutput } from "openclaw/plugin-sdk/feature-contract";
import { contract } from "./contract.js";
import "./control-ui.css";
import { DraftStore } from "./drafts.js";
import { pageEditor } from "./page-editor.js";
import { loadVocabulary } from "./inspection-client.js";
import { initialSearchState, searchToolbar, loadSearch, searchResults } from "./retrieval-view.js";
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
        const draftStatus = el("p", "", "knowledge-error"); draftStatus.setAttribute("role", "alert");
        section.append(header, banner, status, nav, toolbar, draftStatus, content); container.append(section);
        const searchState = initialSearchState();
        const evidenceExpansion = new Map<string, { count: number }>();
        let tab: "records" | "search" | "ontology" | "diagnostics" = "records", offset = 0, query = "", kind = "", type = "", selectedId = "";
        let writesEnabled = false;
        const editorLifetime = new AbortController();
        let vaultChanged = false;
        let draftStore: DraftStore | undefined, draftIdentity = "", editor: ReturnType<typeof pageEditor> | undefined;
        const editPage = (record?: NonNullable<FeatureOutput<typeof contract, "record">["record"]>) => {
          if (editor) { void editor.then(handle => handle?.reopen()); return; }
          if (!draftStore) return;
          try {
            const draft = draftStore.read();
            editor = pageEditor(section, feature, record, id => { editor = undefined; selectedId = id; tab = "records"; renderToolbar(); void refresh(); }, message => context.host.redact(message), { store: draftStore, draft, signal: editorLifetime.signal, dismissed() { editor = undefined; } });
          } catch { draftStatus.textContent = "Stored draft could not be opened. It has been preserved; do not clear browser storage."; }
        };
        let generation = 0, detailGeneration = 0, disposed = false, debounce: ReturnType<typeof setTimeout> | undefined;
        const alive = (n: number) => !disposed && !context.signal.aborted && n === generation && context.host.connection.connected;
        const showError = (error: unknown) => { content.replaceChildren(el("p", "Knowledge unavailable: " + context.host.redact(error instanceof Error ? error.message : String(error)), "knowledge-error")); };
        const tabs = new Map<string, HTMLButtonElement>();
        for (const [key, label] of [["records", "Records"], ["search", "Search"], ["ontology", "Ontology"], ["diagnostics", "Activity & issues"]] as const) {
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
            if (writesEnabled) { const create = button("New page", () => editPage()); create.disabled = !draftStore; toolbar.append(create); }
            toolbar.append(button("Refresh", () => void refresh()));
          }
          if (tab === "search") toolbar.append(searchToolbar(searchState, () => void load(), () => { ++generation; ++detailGeneration; selectedId = ""; content.replaceChildren(el("p", "Search changed. Press Search to update results.")); }));
          toolbar.hidden = tab !== "records" && tab !== "search";
        }
        async function showDetail(id: string, target: HTMLElement, n: number) {
          const detail = ++detailGeneration; selectedId = id; target.replaceChildren(el("p", "Loading record…"));
          try {
            const result = await feature.invoke("record", { id, maxChars: 65536, includeMetadata: true, includeReferences: true, referenceLimit: 100 });
            if (!alive(n) || detail !== detailGeneration) return;
            target.replaceChildren();
            if (!result.record) { target.append(el("h2", "Record unavailable"), el("p", "This ID is missing or duplicated. Inspect Activity & issues; no file was selected arbitrarily.")); return; }
            const r = result.record;
            target.append(el("p", `${r.kind} / ${r.type}`, "knowledge-eyebrow"), el("h2", r.title), el("p", `${r.lifecycle} · Revision ${r.revision}`, "knowledge-muted"), el("code", r.path));
            if (!r.valid) target.append(el("p", "Validation issues — this record is not fully valid.", "knowledge-error"));
            if (writesEnabled && r.kind === "page" && r.valid) target.append(button("Edit page", () => editPage(r)));
            target.append(el("h3", "Authored Markdown"), el("pre", r.body, "knowledge-body"));
            if (result.evidence?.length) {
              if (!evidenceExpansion.has(id)) evidenceExpansion.set(id, { count: 20 });
              target.append(evidenceView(feature, result, () => alive(n) && detail === detailGeneration, s => context.host.redact(s), evidenceExpansion.get(id)));
            }
            if (result.references?.length) {
              target.append(el("h3", "Connected records"));
              const links = el("div", undefined, "knowledge-references");
              for (const ref of result.references) links.append(button(`${ref.title} · ${ref.kind}`, () => void showDetail(ref.id, target, n)));
              target.append(links);
            }
            if (result.nextReferenceOffset !== undefined && result.nextReferenceOffset !== null) {
              const links = el("div", undefined, "knowledge-references");
              let nextOffset = result.nextReferenceOffset;
              const more = button("More connected records", () => {
                more.disabled = true;
                void feature.invoke("record", { id, view: "summary", includeReferences: true, referenceOffset: nextOffset, referenceLimit: 100 }).then(page => {
                  if (!alive(n) || detail !== detailGeneration) return;
                  if (page.record?.hash !== r.hash) throw Error("Record changed; reopen it to refresh connections.");
                  for (const ref of page.references ?? []) links.append(button(`${ref.title} · ${ref.kind}`, () => void showDetail(ref.id, target, n)));
                  if (page.nextReferenceOffset == null) more.remove(); else { nextOffset = page.nextReferenceOffset; more.disabled = false; }
                }).catch(error => { if (alive(n) && detail === detailGeneration) { more.disabled = false; links.append(el("p", context.host.redact(String(error)), "knowledge-error")); } });
              });
              target.append(links, more);
            }
            const raw = button("Read original file", () => {
              raw.disabled = true;
              void feature.invoke("record", { id, view: "raw", maxChars: 65536 }).then(page => {
                if (!alive(n) || detail !== detailGeneration) return;
                if (page.record?.hash !== r.hash) throw Error("Record changed; reopen it to read the current file.");
                raw.replaceWith(rawBlock("Original file (read only)", page.record.raw ?? "", true));
              }).catch(error => { if (alive(n) && detail === detailGeneration) { raw.disabled = false; target.append(el("p", context.host.redact(String(error)), "knowledge-error")); } });
            });
            target.append(raw);
            if (result.issues.length) target.append(issueList(result.issues));
            target.append(rawBlock("Structured fields & metadata", JSON.stringify(r.metadata, null, 2)), rawBlock("Identity & observed content hash", `${r.id}\nSHA-256: ${r.hash}`));
          } catch (error) { if (alive(n) && detail === detailGeneration) target.replaceChildren(el("p", context.host.redact(error instanceof Error ? error.message : String(error)), "knowledge-error")); }
        }
        function recordButton(record: Summary, detail: HTMLElement, n: number) {
          const control = button("", () => { for (const other of content.querySelectorAll(".knowledge-record")) other.setAttribute("aria-pressed", "false"); control.setAttribute("aria-pressed", "true"); void showDetail(record.id, detail, n); });
          control.className = "knowledge-record"; control.setAttribute("aria-pressed", String(record.id === selectedId));
          control.append(el("strong", record.title), el("span", `${record.kind} · ${record.type}`), el("small", record.valid ? `${record.lifecycle}` : "Needs attention")); return control;
        }
        async function load() {
          if (vaultChanged) return;
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
            } else if (tab === "search") {
              if (!searchState.query.trim()) { content.replaceChildren(el("p", "Search accepted, active knowledge by keywords, or resolve an exact identity. Use Records for exhaustive browsing, including records needing attention.")); return; }
              const result = await loadSearch(feature, { ...searchState });
              if (!alive(n)) return;
              if ("index" in result && result.index.state === "ready") {
                if (searchState.offset && searchState.snapshot && searchState.snapshot !== result.index.snapshot) {
                  searchState.offset = 0; searchState.snapshot = undefined;
                  content.replaceChildren(el("p", "Knowledge changed between result pages. Run Search again to restart from the current snapshot.")); return;
                }
                searchState.snapshot = result.index.snapshot;
              }
              const results = searchResults(result, searchState, (id, target) => void showDetail(id, target, n), () => void load());
              content.replaceChildren(results);
              const detail = results.querySelector<HTMLElement>(".knowledge-detail");
              if (detail && selectedId && result.hits.some(hit => hit.record.id === selectedId)) void showDetail(selectedId, detail, n);
            } else if (tab === "ontology") {
              const result = await loadVocabulary(feature, true); if (!alive(n)) return;
              content.replaceChildren(ontologyView(result, id => {
                tab = "records"; selectedId = id; offset = 0; query = ""; kind = ""; type = ""; renderToolbar(); void load();
              }, () => { tab = "diagnostics"; renderToolbar(); void load(); }));

            } else {
              const [history, diagnostics] = await Promise.allSettled([feature.invoke("history", {}), feature.invoke("diagnostics", {})]);
              if (!alive(n)) return;
              content.replaceChildren(el("h2", "Activity & issues"));
              if (history.status === "fulfilled") {
                const git = history.value.git;
                content.append(el("p", `Local Git history: ${git.state}${git.pending ? ` · ${git.pending} checkpoints waiting` : ""}. ${git.message}`));
                for (const receipt of history.value.mutations) {
                  const item = el("article", undefined, "knowledge-evidence");
                  item.append(el("strong", `${receipt.state} · Revision ${receipt.revision}`), el("p", receipt.path), el("p", receipt.message));
                  if (receipt.git) item.append(el("p", `Git: ${receipt.git.state}${receipt.git.commit ? ` · ${receipt.git.commit.slice(0, 12)}` : ""}. ${receipt.git.message}`));
                  if (receipt.state === "published" && receipt.git && receipt.git.state !== "committed" && writesEnabled) item.append(button("Retry Git history", () => { void feature.invoke("resume", { requestId: receipt.requestId }).then(() => refresh()).catch(showError); }));
                  if (receipt.state === "accepted" && writesEnabled) item.append(button("Resume save", () => { void feature.invoke("resume", { requestId: receipt.requestId }).then(() => refresh()).catch(showError); }));
                  item.append(button("Inspect saved versions", () => {
                    void feature.invoke("mutation", { requestId: receipt.requestId }).then(result => {
                      if (!alive(n)) return;
                      for (const file of result.files) item.append(rawBlock(`${file.path} · Before`, file.before ?? "New file"), rawBlock(`${file.path} · Proposed`, file.proposed), rawBlock(`${file.path} · Displaced file`, file.displaced ?? "None"));
                    }).catch(showError);
                  }));
                  content.append(item);
                }
                for (const entry of history.value.entries) {
                  const row = el("article"); row.append(el("p", `${entry.provenance} · ${entry.path} · Revision ${entry.revision} · ${new Date(entry.at).toLocaleString()}`));
                  row.append(button("Read revision", () => { void feature.invoke("revision", { sequence: entry.sequence }).then(result => { if (alive(n)) row.append(rawBlock("Historical snapshot", result.raw ?? "Unavailable", true)); }).catch(showError); }));
                  content.append(row);
                }
                if (!history.value.mutations.length && !history.value.entries.length) content.append(el("p", "No recorded mutations in this scope."));
                if (history.value.nextOffset !== null) content.append(el("p", "Showing the latest 50 history entries. Older history is available through the history operation."));
              } else content.append(el("p", context.host.redact(String(history.reason)), "knowledge-error"));
              if (diagnostics.status === "fulfilled") content.append(diagnostics.value.issues.length ? issueList(diagnostics.value.issues) : el("p", "No validation issues found."));
              else content.append(el("p", context.host.redact(String(diagnostics.reason)), "knowledge-error"));
            }
          } catch (error) { if (alive(n)) showError(error); }
        }
        let statusGeneration = 0;
        async function refresh() {
          if (vaultChanged) return;
          const n = ++statusGeneration;
          void load();
          if (!context.host.connection.connected) { status.textContent = "Disconnected — waiting for OpenClaw."; return; }
          status.textContent = "Checking vault…";
          try {
            const report = await feature.invoke("status", {});
            if (disposed || context.signal.aborted || n !== statusGeneration || !context.host.connection.connected) return;
            const toolbarChanged = !draftIdentity || writesEnabled !== report.writesEnabled;
            writesEnabled = report.writesEnabled;
            const identity = JSON.stringify([report.agent, report.vault, report.scope]);
            if (draftIdentity && identity !== draftIdentity) {
              // Remount to fence all editor callbacks and data from the previous identity.
              vaultChanged = true; editorLifetime.abort(); ++generation; ++detailGeneration; writesEnabled = false; renderToolbar(); content.replaceChildren(el("p", "Connected vault changed. Reload this page to open it; the previous draft is retained separately."));
              for (const dialog of section.querySelectorAll("dialog")) dialog.remove();
              status.textContent = "Vault changed — reload required."; return;
            }
            if (!draftIdentity) {
              draftIdentity = identity;
              try { draftStore = new DraftStore(report, window.sessionStorage); if (writesEnabled && draftStore.read()) editPage(); }
              catch { draftStatus.textContent = "Browser draft recovery unavailable. Copy any draft before leaving."; }
            }
            if (toolbarChanged) renderToolbar();
            banner.replaceChildren(el("strong", report.sample ? "Sample vault · Read only" : `${report.agent} · Private vault${writesEnabled ? "" : " · Read only"}`), el("p", report.sample ? "Fictional people and projects for exploring the data model. No private agent vault is connected." : (writesEnabled ? "Create pages, attach source files, and edit with revision checks." : "Your agent’s knowledge. Writing is not enabled for this connection.")));
            if (writesEnabled && selectedId) void load();
            status.textContent = `${report.records} ${report.sample ? "sample " : ""}records${report.issues ? ` · ${report.issues} issues to review` : ""}` + (report.live === "unavailable" ? " · Live watcher unavailable; periodic refresh remains active." : "");
          } catch (error) { if (!disposed && n === statusGeneration) status.textContent = "Knowledge unavailable: " + context.host.redact(error instanceof Error ? error.message : String(error)); }
        }
        let connected = context.host.connection.connected;
        const unsubscribe = context.host.subscribe(() => { if (connected !== context.host.connection.connected) { connected = context.host.connection.connected; void refresh(); } });
        const unwatch = feature.on("changed", () => void refresh());
        // Covers dropped notifications, backend-only reload, and watcher failure.
        const resync = setInterval(() => { if (context.host.connection.connected && !document.hidden) void refresh(); }, 30000);
        renderToolbar(); void refresh();
        return { dispose() { editorLifetime.abort(); disposed = true; ++generation; ++detailGeneration; ++statusGeneration; clearTimeout(debounce); clearInterval(resync); unwatch(); unsubscribe(); section.remove(); } };
      },
    });
    return () => { removePage(); removeNavigation(); };
  },
});
