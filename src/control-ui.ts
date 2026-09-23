import { defineControlUiPlugin } from "openclaw/plugin-sdk/control-ui";
import { createFeatureClient, type FeatureOutput } from "openclaw/plugin-sdk/feature-contract";
import { contract } from "./contract.js";
import { evidenceView } from "./evidence-view.js";
import { loadVocabulary } from "./inspection-client.js";
import { ontologyView } from "./ontology-view.js";
import "./control-ui.css";

type Summary = FeatureOutput<typeof contract, "records">["records"][number];
type Detail = FeatureOutput<typeof contract, "record">;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n; };
const button = (text: string, run: () => void, className = "btn") => { const n = el("button", text, className); n.type = "button"; n.onclick = run; return n; };
const chip = (text: string) => el("span", text, "chip knowledge-chip");
const human = (text: string) => text.replaceAll("_", " ").replaceAll("-", " ");
const date = (text: string) => new Date(text).toLocaleString();
const origin = (value?: string) => value === "source" ? "From source" : value === "user_belief" ? "User statement" : value === "agent_inference" ? "Agent inferred" : "Origin not recorded";
const rawBlock = (label: string, text: string) => { const n = el("details"); n.append(el("summary", label), el("pre", text)); return n; };

export default defineControlUiPlugin({
  id: contract.pluginId,
  activate(host) {
    const removeNavigation = host.ui.registerNavigation({ id: "knowledge", label: "Knowledge", page: { id: "overview" }, icon: "book" });
    const removePage = host.ui.registerPage({ id: "overview", label: "Knowledge", mount(container, context) {
      const feature = createFeatureClient(contract, context.host);
      const root = el("section", undefined, "knowledge-page"), header = el("header", undefined, "knowledge-header"), title = el("div"), actions = el("div", undefined, "knowledge-actions");
      title.append(el("h1", "Knowledge"), el("p", "What your agent has saved, and where it came from."));
      const status = el("span", "Connecting…", "knowledge-status"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
      actions.append(status, button("Vocabulary", () => navigate("ontology"), "btn knowledge-quiet"), button("Vault status", () => navigate("diagnostics"), "btn knowledge-quiet"));
      header.append(title, actions);
      const nav = el("nav", undefined, "knowledge-tabs"); nav.setAttribute("aria-label", "Knowledge views");
      const recentTab = button("Recent", () => navigate("recent")), browseTab = button("Browse", () => navigate("browse")); nav.append(recentTab, browseTab);
      const banner = el("p", "", "knowledge-notice"), toolbar = el("div", undefined, "knowledge-toolbar"), content = el("div", undefined, "knowledge-content");
      root.append(header, nav, banner, toolbar, content); container.append(root);
      let tab: "recent" | "browse" | "search" | "ontology" | "diagnostics" = "recent", selectedId = "", query = "", kind: "page" | "claim" | "relationship" = "page", type = "", offset = 0, historyOffset = 0;
      let generation = 0, statusGeneration = 0, disposed = false, identity = "", vaultChanged = false, agentId = "";
      let searchSnapshot: string | null | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined, suggestGeneration = 0;
      let vocabulary: Awaited<ReturnType<typeof loadVocabulary>> | undefined;
      const live = (n: number) => !disposed && !context.signal.aborted && !vaultChanged && n === generation && context.host.connection.connected;
      const errorText = (error: unknown) => context.host.redact(error instanceof Error ? error.message : String(error));
      const failure = (error: unknown) => el("p", errorText(error), "knowledge-error");
      const empty = (heading: string, text: string) => { const n = el("div", undefined, "knowledge-empty"); n.append(el("h2", heading), el("p", text)); return n; };
      function navigate(next: typeof tab) { tab = next; selectedId = ""; offset = 0; historyOffset = 0; renderToolbar(); void load(); }
      function open(id: string) { selectedId = id; renderToolbar(); void load(); }
      function ask(record: NonNullable<Detail["record"]>, correct = false) {
        root.querySelector(".knowledge-chat-handoff")?.remove();
        const panel = el("section", undefined, "knowledge-chat-handoff knowledge-surface");
        panel.append(el("h3", correct ? "Correct in chat" : "Ask your agent"), el("p", "Copy this request, then open chat and paste it. Review and send it there. This host cannot pre-fill the chat box yet."));
        const prompt = el("textarea"); prompt.readOnly = true; prompt.rows = 5; prompt.setAttribute("aria-label", "Chat request");
        prompt.value = `${correct ? "I want to correct" : "What do you know about"} this knowledge ${record.kind}: ${record.title}\nID: ${record.id}\nObserved revision: ${record.revision}\nObserved SHA-256: ${record.hash}\n${correct ? "The correction is: " : "Please explain it and its evidence."}`;
        const feedback = el("p"); feedback.setAttribute("role", "status");
        const copy = button("Copy request", () => { void navigator.clipboard.writeText(prompt.value).then(() => { feedback.textContent = "Copied. Paste it in chat; nothing has been sent."; }).catch(() => { prompt.select(); feedback.textContent = "Select and copy the request above."; }); });
        const chat = button("Open chat", () => {
          chat.disabled = true;
          void (async () => { const key = await context.host.sessions.create({ agentId: agentId || undefined }); if (key) context.host.sessions.open({ sessionKey: key, agentId: agentId || undefined }); else feedback.textContent = "Chat was not opened. Your request is still here."; })().catch(error => { feedback.textContent = errorText(error); }).finally(() => { chat.disabled = false; });
        });
        panel.append(prompt, copy, chat, button("Dismiss", () => panel.remove(), "btn knowledge-quiet"), feedback); toolbar.after(panel); prompt.focus();
      }
      function renderToolbar() {
        recentTab.setAttribute("aria-pressed", String(!selectedId && tab === "recent")); browseTab.setAttribute("aria-pressed", String(!selectedId && tab === "browse"));
        toolbar.replaceChildren(); ++suggestGeneration; clearTimeout(timer);
        if (selectedId || tab === "ontology" || tab === "diagnostics") return;
        const form = el("form", undefined, "knowledge-search"), input = el("input"), suggestions = el("div", undefined, "knowledge-suggestions");
        input.type = "search"; input.maxLength = 200; input.placeholder = "Search people, projects, and everything else…"; input.value = query; input.setAttribute("aria-label", "Search knowledge");
        const submit = el("button", "Search all text", "btn knowledge-quiet"); submit.type = "submit";
        form.append(input, submit, suggestions);
        form.onsubmit = event => { event.preventDefault(); query = input.value.trim(); offset = 0; searchSnapshot = undefined; tab = "search"; suggestions.replaceChildren(); renderToolbar(); void load(); };
        input.oninput = () => {
          query = input.value; const token = ++suggestGeneration; clearTimeout(timer); suggestions.replaceChildren();
          if (!query.trim()) return;
          // Exact identity lookup is supported today. Do not present it as prefix search.
          timer = setTimeout(() => { void feature.invoke("lookup", { query: query.trim(), limit: 10 }).then(result => {
            if (disposed || token !== suggestGeneration || !context.host.connection.connected) return;
            suggestions.replaceChildren(); if (!result.hits.length) return;
            suggestions.append(el("small", "Exact names and aliases"));
            for (const hit of result.hits) suggestions.append(button(hit.record.title, () => open(hit.record.id), "knowledge-suggestion"));
          }).catch(() => {}); }, 200);
        };
        input.onkeydown = event => { if (event.key === "Escape") { ++suggestGeneration; suggestions.replaceChildren(); } };
        toolbar.append(form);
      }
      function summaryLink(r: Summary) { const b = button(r.title, () => open(r.id), "knowledge-record-link"); b.append(chip(human(r.type)), ...(r.lifecycle !== "active" ? [chip(human(r.lifecycle))] : [])); return b; }
      async function claimCard(r: Summary, n: number, aboutId?: string) {
        const result = await feature.invoke("record", { id: r.id, maxChars: 4000, includeMetadata: true });
        if (!live(n) || !result.record) return undefined;
        const record = result.record, card = el("article", undefined, "knowledge-claim"); card.dataset.kind = aboutId && !record.metadata?.entities?.includes(aboutId) && record.metadata?.owner === aboutId ? "Owned commitments" : record.claimKind ?? "other";
        const top = el("div", undefined, "knowledge-claim-heading"); top.append(chip(human(record.claimKind ?? "claim")), el("span", origin(record.assertionOrigin), `knowledge-origin knowledge-origin-${record.assertionOrigin ?? "unknown"}`));
        card.append(top, button(record.body || record.title, () => open(record.id), "knowledge-claim-text"));
        if (result.content.nextOffset !== null) card.append(el("small", "Excerpt — open claim for the complete text."));
        if (record.attribution) card.append(el("p", record.attribution, "knowledge-attribution"));
        const dates = [record.metadata?.occurred_at ? `Occurred ${record.metadata.occurred_at}` : "", record.metadata?.due_at ? `Due ${record.metadata.due_at}` : ""].filter(Boolean);
        if (dates.length) card.append(el("p", dates.join(" · "), "knowledge-attribution"));
        const evidence = el("details"); evidence.append(el("summary", `Evidence · ${result.evidenceTotal ?? 0} source files`));
        if (record.assertionOrigin === "agent_inference") evidence.append(el("p", "This is the agent’s inference, not a quoted source statement. Supporting material, if any, is shown below."));
        if (result.evidence?.length) evidence.append(evidenceView(feature, result, () => live(n), errorText)); else evidence.append(el("p", "No source evidence recorded."));
        card.append(evidence, button("Correct in chat", () => ask(record, true), "btn knowledge-quiet")); return card;
      }
      async function showDetail(id: string, n: number) {
        const result = await feature.invoke("record", { id, maxChars: 65536, includeMetadata: true, includeReferences: true, referenceLimit: 20 });
        if (!live(n)) return;
        if (!result.record) { content.replaceChildren(empty("Record unavailable", "This record cannot be opened in the current scope. No matching record was selected arbitrarily.")); return; }
        const r = result.record, meta = r.metadata;
        const head = el("header", undefined, "knowledge-entity-header"), heading = el("div");
        heading.append(el("p", human(r.type), "knowledge-eyebrow"), el("h2", r.title));
        const facts = el("div", undefined, "knowledge-inline-facts");
        for (const alias of meta?.aliases ?? []) facts.append(chip(alias));
        const fieldNodes = new Map<string, HTMLElement>();
        for (const [name, value] of Object.entries(meta?.fields ?? {})) { const node = el("span", `${human(name)}: ${typeof value === "object" ? JSON.stringify(value) : value}`); fieldNodes.set(name, node); facts.append(node); }
        if (fieldNodes.size) void feature.invoke("ontology", { view: "definitions", name: r.type, limit: 1 }).then(schema => { if (!live(n)) return; for (const field of schema.definitions?.[0]?.fields ?? []) { const node = fieldNodes.get(field.name), value = meta?.fields?.[field.name]; if (node) node.textContent = `${field.label}: ${typeof value === "object" ? JSON.stringify(value) : value}`; } }).catch(() => {});
        if (meta?.updated_at) facts.append(el("span", `Last updated ${date(meta.updated_at)}`));
        heading.append(facts); head.append(heading, button("Ask your agent", () => ask(r)));
        const back = button("← Knowledge", () => { selectedId = ""; renderToolbar(); void load(); }, "btn knowledge-quiet");
        const grid = el("div", undefined, "knowledge-entity-grid"), main = el("div", undefined, "knowledge-entity-main"), aside = el("aside", undefined, "knowledge-entity-aside");
        if (!r.valid) main.append(el("p", "This record has validation issues.", "knowledge-notice"));
        if (r.lifecycle !== "active") main.append(el("p", `${human(r.lifecycle)} — historical knowledge, not a current assertion.`, "knowledge-notice"));
        const lifecycle = meta as Record<string, unknown> | undefined;
        const change = lifecycle?.lifecycle_change;
        if (change && typeof change === "object" && "reason" in change && typeof change.reason === "string") main.append(el("p", change.reason, "knowledge-notice"));
        if (typeof lifecycle?.superseded_by === "string") main.append(button("View replacement →", () => open(lifecycle.superseded_by as string), "btn knowledge-quiet"));
        if (typeof lifecycle?.supersedes === "string") main.append(button("View original assertion", () => open(lifecycle.supersedes as string), "btn knowledge-quiet"));
        const body = el("div", undefined, "knowledge-summary");
        // textContent keeps portable Markdown safe; raw Markdown remains in File details.
        for (const paragraph of (r.body ?? "").split(/\n\s*\n/)) body.append(el("p", paragraph));
        main.append(body);
        if (result.content.nextOffset !== null) main.append(el("p", "Summary preview is truncated. Open the original Markdown below for paged content."));
        if (r.kind !== "page") { main.append(el("p", origin(r.assertionOrigin), "knowledge-origin")); if (r.attribution) main.append(el("p", r.attribution)); main.append(button("Correct in chat", () => ask(r, true), "btn knowledge-quiet")); }
        const claims = el("section"), connections = el("section"), learned = el("section");
        if (r.kind === "page") { claims.append(el("h3", "What your agent knows")); main.append(claims); }
        connections.append(el("h3", "Connections")); learned.append(el("h3", "Learned in"), el("p", "Conversation provenance is not recorded for these saves yet.", "knowledge-muted")); aside.append(connections, learned);
        const files = el("details", undefined, "knowledge-file-details"); files.append(el("summary", "File details"));
        const dl = el("dl"); for (const [label, value] of [["File", r.path], ["ID", r.id], ["Revision", String(r.revision)], ["Lifecycle", r.lifecycle], ["SHA-256", r.hash]]) dl.append(el("dt", label), el("dd", value));
        files.append(dl, rawBlock("Structured metadata", JSON.stringify(meta, null, 2)));
        const raw = button("View Markdown", () => {
          raw.disabled = true; let next = 0; const text = el("pre"); const more = button("Read more Markdown", () => { void read(); });
          async function read() { more.disabled = true; try { const page = await feature.invoke("record", { id, view: "raw", offset: next, maxChars: 65536 }); if (!live(n)) return; if (page.record?.hash !== r.hash) throw Error("Record changed; reopen it to read the current Markdown."); text.textContent += page.record.raw ?? ""; if (page.content.nextOffset === null) more.remove(); else { next = page.content.nextOffset; more.disabled = false; } } catch (error) { files.append(failure(error)); more.disabled = false; } }
          files.append(text, more); void read();
        }); files.append(raw); aside.append(files);
        if (result.evidence?.length) { const sources = el("details"); sources.append(el("summary", `Sources · ${result.evidenceTotal ?? 0}`), evidenceView(feature, result, () => live(n), errorText)); main.append(sources); }
        grid.append(main, aside); content.replaceChildren(back, head, grid);
        const refs = el("div"); connections.append(refs);
        let linkOffset = 0, snapshot: string | undefined; const claimGroups = new Map<string, HTMLElement>();
        async function moreConnections() {
          const page = await feature.invoke("connections", { id, offset: linkOffset, limit: 20 }); if (!live(n)) return;
          if (snapshot && snapshot !== page.snapshot) throw Error("Connections changed; reopen this page to refresh."); snapshot = page.snapshot;
          const [cards, endpoints] = await Promise.all([
            Promise.all(page.connections.map(async link => link.direction === "claims" ? claimCard(link.record, n, id) : undefined)),
            Promise.all(page.connections.map(async link => {
              const targetId = link.direction === "incoming" ? link.from : link.direction === "outgoing" ? link.to : undefined;
              return targetId ? (await feature.invoke("record", { id: targetId, view: "summary" })).record : null;
            })),
          ]); if (!live(n)) return;
          for (const [i, link] of page.connections.entries()) {
            if (link.direction === "claims" && r.kind === "page") { const card = cards[i]; if (!card) continue; const kind = card.dataset.kind!; let group = claimGroups.get(kind); if (!group) { group = el("div", undefined, "knowledge-surface"); group.append(el("h4", human(kind))); claimGroups.set(kind, group); claims.append(group); } group.append(card); }
            else { const row = el("div", undefined, "knowledge-connection"); row.append(el("small", `${link.direction === "incoming" ? "← " : link.direction === "outgoing" ? "→ " : "Depends on this · "}${human(link.label ?? link.direction)}`), summaryLink(endpoints[i] ?? link.record)); if (endpoints[i]) row.append(button("Relationship evidence", () => open(link.record.id), "btn knowledge-quiet")); refs.append(row); }
          }
          loadMore.remove(); if (page.nextOffset !== null) { linkOffset = page.nextOffset; connections.append(loadMore); }
          else { if (!refs.children.length) refs.append(el("p", "No active typed connections.")); if (r.kind === "page" && !claimGroups.size) claims.append(el("p", "No active linked claims. Tell your agent in chat to add knowledge.")); }
        }
        const loadMore = button("More claims and connections", () => { loadMore.disabled = true; void moreConnections().catch(error => { connections.append(failure(error)); }).finally(() => { loadMore.disabled = false; }); });
        void moreConnections().catch(error => { if (live(n)) connections.append(failure(error)); });
        if (result.references?.length) { const references = el("details"); references.append(el("summary", "Record references · not asserted relationships")); for (const ref of result.references) references.append(summaryLink(ref)); if (result.nextReferenceOffset != null) references.append(el("p", "Showing the first 20 references.")); aside.append(references); }
        void feature.invoke("history", { id, limit: 10 }).then(history => { if (!live(n)) return; const checkpoint = history.mutations.find(m => m.hash === r.hash)?.git; files.append(el("p", checkpoint ? `Git: ${checkpoint.state}. ${checkpoint.message}` : "Git checkpoint not recorded for this revision.")); const list = el("details"); list.append(el("summary", "Saved history")); for (const entry of history.entries) list.append(el("p", `Revision ${entry.revision} · ${date(entry.at)} · ${human(entry.provenance)}`)); if (history.nextOffset !== null) list.append(el("p", "Showing the latest 10 revisions.")); files.append(list); }).catch(error => { if (live(n)) files.append(failure(error)); });
      }
      async function browse(n: number) {
        const result = await feature.invoke("records", { kind, offset, limit: 50, ...(type ? { type } : {}) });
        if (!live(n)) return;
        const layout = el("div", undefined, "knowledge-browse"), facets = el("nav", undefined, "knowledge-facets"); facets.setAttribute("aria-label", "Types");
        const facet = (name: string, label: string, count?: number) => { const control = button(label, () => { type = name; offset = 0; void load(); }, "knowledge-facet"); control.setAttribute("aria-pressed", String(type === name)); if (count !== undefined) control.append(el("span", count.toLocaleString())); facets.append(control); };
        facet("", "Everything");
        if (kind === "page" && vocabulary) { let group = ""; for (const def of [...vocabulary.definitions].filter(d => d.recordCount > 0).sort((a, b) => a.primitive.localeCompare(b.primitive))) { if (group !== def.primitive) { group = def.primitive; facets.append(el("h3", human(group), "knowledge-eyebrow")); } facet(def.name, def.label, def.recordCount); } facets.append(el("p", `${vocabulary.definitions.filter(d => !d.recordCount).length} empty types hidden`, "knowledge-muted")); }
        const panel = el("div", undefined, "knowledge-surface knowledge-table-wrap"), controls = el("div", undefined, "knowledge-table-toolbar");
        for (const [value, label] of [["page", "Pages"], ["claim", "Claims"], ["relationship", "Connections"]] as const) { const b = button(label, () => { kind = value; type = ""; offset = 0; void load(); }, "btn knowledge-quiet"); b.setAttribute("aria-pressed", String(kind === value)); controls.append(b); }
        panel.append(controls);
        if (kind === "claim") { const cards = await Promise.all(result.records.map(r => claimCard(r, n))); if (!live(n)) return; for (const card of cards) if (card) panel.append(card); }
        else { const table = el("table", undefined, "data-table knowledge-table"), head = el("thead"), row = el("tr"); for (const label of ["Name", "Type", "Status"]) row.append(el("th", label)); head.append(row); table.append(head); const body = el("tbody"); for (const record of result.records) { const row = el("tr"), name = el("td"); name.append(button(record.title, () => open(record.id), "knowledge-record-link")); row.append(name, el("td", human(record.type)), el("td", record.valid ? human(record.lifecycle) : "Needs attention")); body.append(row); } table.append(body); panel.append(table); }
        if (!result.records.length) panel.append(empty("Nothing here yet", "Tell your agent in chat and saved knowledge will appear here."));
        const pages = el("div", undefined, "knowledge-pagination");
        const capped = result.nextOffset !== null && result.nextOffset > 500;
        pages.append(el("span", `${result.total ? offset + 1 : 0}–${offset + result.records.length} of ${result.total.toLocaleString()} · ${result.total > 550 ? "partial browse access" : "complete inventory, paginated"}`));
        const previous = button("Previous", () => { offset = Math.max(0, offset - 50); void load(); }); previous.disabled = !offset;
        const next = button("Next", () => { offset = result.nextOffset!; void load(); }); next.disabled = result.nextOffset === null || capped; pages.append(previous, next); panel.append(pages);
        if (capped) panel.append(el("p", "This server cannot page beyond 550 records. Narrow the type filter to see more.", "knowledge-notice"));
        panel.append(el("p", "Listed in server order. Last-saved sorting and stable paging are not available yet.", "knowledge-muted knowledge-list-note"));
        layout.append(facets, panel); content.replaceChildren(layout);
      }
      async function recent(n: number) {
        const history = await feature.invoke("history", { offset: historyOffset, limit: 20 }); if (!live(n)) return;
        const feed = el("div", undefined, "knowledge-feed");
        feed.append(el("p", "Recorded activity · Conversation grouping and attention counts are not available for these saves yet.", "knowledge-muted"));
        const details = await Promise.all(history.entries.map(entry => feature.invoke("record", { id: entry.id, view: "summary" }))); if (!live(n)) return;
        let currentDay = "", group: HTMLElement | undefined;
        for (const [i, entry] of history.entries.entries()) { const r = details[i].record; if (!r) continue; const day = new Date(entry.at).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }); if (day !== currentDay) { currentDay = day; feed.append(el("h2", day, "knowledge-eyebrow")); group = el("section", undefined, "knowledge-surface"); feed.append(group); } const row = el("article", undefined, "knowledge-feed-item"); if (r.lifecycle !== "active") {
            row.classList.add("knowledge-historical-notice");
            row.append(el("span", `${human(r.kind)} · Current status: ${human(r.lifecycle)}`), el("small", `Recorded revision ${entry.revision} · ${date(entry.at)}`, "knowledge-muted"), button("Inspect historical record", () => open(r.id), "btn knowledge-quiet"));
          } else row.append(summaryLink(r), el("span", `Revision ${entry.revision} · ${date(entry.at)}`, "knowledge-muted"), chip(entry.provenance === "external" ? "Edited outside OpenClaw" : entry.revision === 1 ? "Saved" : "Updated"));
          group!.append(row); }
        if (!history.entries.length) feed.append(empty("No recorded activity yet", "Knowledge saved by your agent will appear here. Existing vault records are available in Browse."));
        const pages = el("div", undefined, "knowledge-pagination"); if (historyOffset) pages.append(button("Newer activity", () => { historyOffset = Math.max(0, historyOffset - 20); void load(); })); if (history.nextOffset !== null) pages.append(button("Older activity", () => { historyOffset = history.nextOffset!; void load(); })); feed.append(pages); content.replaceChildren(feed);
      }
      async function load() {
        const n = ++generation; if (vaultChanged) return;
        if (!context.host.connection.connected) { content.replaceChildren(empty("Disconnected", "Reconnect to read your agent’s knowledge.")); return; }
        content.replaceChildren(el("p", "Loading…", "knowledge-muted"));
        try {
          if (selectedId) return await showDetail(selectedId, n);
          if (tab === "recent") return await recent(n);
          if (tab === "browse") return await browse(n);
          if (tab === "ontology") { const result = await loadVocabulary(feature, true); if (live(n)) content.replaceChildren(button("← Knowledge", () => navigate("recent"), "btn knowledge-quiet"), ontologyView(result, open, () => navigate("diagnostics"))); return; }
          if (tab === "diagnostics") { const result = await feature.invoke("diagnostics", {}); if (!live(n)) return; const panel = empty("Vault status", `${result.total} validation findings. Knowledge changes happen through your agent in chat.`); for (const issue of result.issues) panel.append(el("p", `${human(issue.code)} · ${issue.path}: ${issue.message}`)); content.replaceChildren(panel); return; }
          if (!query.trim()) { content.replaceChildren(empty("Search knowledge", "Enter a name or a few words to search all saved text.")); return; }
          const result = await feature.invoke("grep", { query: query.trim(), limit: 20, offset }); if (!live(n)) return;
          if (result.index.state !== "ready") { content.replaceChildren(empty("Search unavailable", result.index.message)); return; }
          if (offset && searchSnapshot && searchSnapshot !== result.index.snapshot) { offset = 0; searchSnapshot = undefined; content.replaceChildren(empty("Knowledge changed", "Run the search again to restart from the current snapshot.")); return; }
          searchSnapshot = result.index.snapshot;
          const list = el("div", undefined, "knowledge-surface"); list.append(el("p", `${result.total} matches · Ranked text search, not a complete inventory`, "knowledge-list-note"));
          if (!result.coverage.complete) list.append(el("p", result.coverage.message, "knowledge-notice"));
          for (const hit of result.hits) { const row = el("article", undefined, "knowledge-search-hit"); row.append(summaryLink(hit.record), el("p", hit.snippet.text), el("small", `Revision ${hit.citation.revision} · ${hit.citation.path}`)); list.append(row); }
          if (!result.total) list.append(empty("No matches", "Try another name or phrase, or browse by type."));
          const pages = el("div", undefined, "knowledge-pagination"); if (offset) pages.append(button("Previous", () => { offset = Math.max(0, offset - 20); void load(); })); if (result.nextOffset !== null) { const next = button("Next", () => { offset = result.nextOffset!; void load(); }); next.disabled = result.nextOffset > 500; pages.append(next); if (next.disabled) list.append(el("p", "This server cannot page beyond 520 search results. Refine your query to see more.", "knowledge-notice")); } list.append(pages); content.replaceChildren(list);
        } catch (error) { if (live(n)) content.replaceChildren(failure(error)); }
      }
      async function refresh() {
        if (vaultChanged) return; const n = ++statusGeneration;
        if (!context.host.connection.connected) { status.textContent = "Disconnected"; void load(); return; }
        try {
          const report = await feature.invoke("status", {}); if (disposed || n !== statusGeneration || !context.host.connection.connected) return;
          const nextIdentity = JSON.stringify([report.agent, report.vault, report.scope]);
          if (identity && identity !== nextIdentity) { vaultChanged = true; ++generation; ++suggestGeneration; toolbar.replaceChildren(); root.querySelector(".knowledge-chat-handoff")?.remove(); status.textContent = "Vault changed"; content.replaceChildren(empty("Vault changed", "Reload this page to open the newly connected vault.")); return; }
          identity = nextIdentity; agentId = report.agent;
          status.textContent = report.live === "watching" ? "● Live" : "Periodic refresh";
          banner.hidden = !report.sample; banner.textContent = report.sample ? "Sample vault · Fictional people and projects. Your private knowledge is not connected." : "";
          vocabulary = await loadVocabulary(feature); if (disposed || n !== statusGeneration) return;
          void load();
        } catch (error) { if (!disposed && n === statusGeneration) { status.textContent = "Unavailable"; content.replaceChildren(failure(error)); } }
      }
      let connected = context.host.connection.connected;
      const unsubscribe = context.host.subscribe(() => { if (connected !== context.host.connection.connected) { connected = context.host.connection.connected; ++suggestGeneration; toolbar.querySelector(".knowledge-suggestions")?.replaceChildren(); void refresh(); } });
      const unwatch = feature.on("changed", () => void refresh());
      const resync = setInterval(() => { if (context.host.connection.connected && !document.hidden) void refresh(); }, 30000);
      renderToolbar(); void refresh();
      return { dispose() { disposed = true; ++generation; ++statusGeneration; ++suggestGeneration; clearTimeout(timer); clearInterval(resync); unwatch(); unsubscribe(); root.remove(); } };
    } });
    return () => { removePage(); removeNavigation(); };
  },
});
