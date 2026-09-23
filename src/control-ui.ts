import { defineControlUiPlugin } from "openclaw/plugin-sdk/control-ui";
import { createFeatureClient, type FeatureOutput } from "openclaw/plugin-sdk/feature-contract";
import { contract } from "./contract.js";
import { evidenceView } from "./evidence-view.js";
import { loadVocabulary } from "./inspection-client.js";
import { ontologyView } from "./ontology-view.js";
import { icon, type IconName } from "./ui-icons.js";
import "./control-ui.css";

type Summary = FeatureOutput<typeof contract, "records">["records"][number];
type Detail = FeatureOutput<typeof contract, "record">;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n; };
const button = (text: string, run: () => void, className = "knowledge-button") => { const n = el("button", text, className); n.type = "button"; n.onclick = run; return n; };
const chip = (text: string) => el("span", text, "chip knowledge-chip");
const human = (text: string) => text.replaceAll("_", " ").replaceAll("-", " ");
const label = (text: string) => human(text).replace(/^./, c => c.toUpperCase());
const typeIcons: Record<string, [IconName, string]> = { person: ["circleUser", "teal"], company: ["box", "blue"], organization: ["box", "blue"], project: ["kanban", "green"], concept: ["spark", "amber"], meeting: ["users", "red"], email: ["mail", "neutral"], source: ["paperclip", "neutral"], decision: ["flag", "neutral"], commitment: ["listChecks", "neutral"], preference: ["star", "neutral"], fact: ["info", "neutral"], belief: ["brain", "neutral"], event: ["calendarClock", "neutral"] };
const tile = (type: string, size = 28, kind = "page") => { const [glyph, tone] = (Object.hasOwn(typeIcons, type) ? typeIcons[type] : undefined) ?? [kind === "relationship" ? "link" : "fileText", "neutral"]; const n = el("span", undefined, `knowledge-tile knowledge-tone-${tone}${kind === "page" ? "" : " knowledge-tile-plain"}`); n.style.setProperty("--tile-size", `${size}px`); n.append(icon(glyph, size >= 48 ? 24 : size <= 24 ? 13 : 15)); return n; };
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
      const vocabularyButton = button("", () => navigate("ontology"), "knowledge-icon-button"); vocabularyButton.setAttribute("aria-label", "Vocabulary"); vocabularyButton.title = "Ontology & vault settings"; vocabularyButton.append(icon("book"));
      actions.append(status, vocabularyButton);
      const nav = el("nav", undefined, "knowledge-tabs"); nav.setAttribute("aria-label", "Knowledge views");
      // These are text navigation tabs, not host .btn controls. Theme-specific
      // .btn rules otherwise reintroduce filled backgrounds in light mode.
      const recentTab = button("Recent", () => navigate("recent"), "knowledge-tab"), browseTab = button("Browse", () => navigate("browse"), "knowledge-tab"); nav.append(recentTab, browseTab);
      const banner = el("p", "", "knowledge-notice"), toolbar = el("div", undefined, "knowledge-toolbar"), content = el("div", undefined, "knowledge-content");
      header.append(title, nav, actions);
      const body = el("div", undefined, "knowledge-page-body"); body.append(banner, toolbar, content);
      root.append(header, body); container.append(root);
      let tab: "recent" | "browse" | "search" | "ontology" | "diagnostics" = "recent", selectedId = "", query = "", kind: "page" | "claim" | "relationship" = "page", type = "", offset = 0;
      type RecentCursor = { upperSequence: number; beforeSequence: number } | undefined;
      let recentCursor: RecentCursor;
      const recentBack: RecentCursor[] = [];
      const recentExpanded = new Set<number>();
      let generation = 0, statusGeneration = 0, disposed = false, identity = "", vaultChanged = false, agentId = "";
      let searchSnapshot: string | null | undefined;
      let browseSearch: HTMLFormElement | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined, suggestGeneration = 0;
      let vocabulary: Awaited<ReturnType<typeof loadVocabulary>> | undefined;
      const live = (n: number) => !disposed && !context.signal.aborted && !vaultChanged && n === generation && context.host.connection.connected;
      const errorText = (error: unknown) => context.host.redact(error instanceof Error ? error.message : String(error));
      const failure = (error: unknown) => el("p", errorText(error), "knowledge-error");
      const empty = (heading: string, text: string) => { const n = el("div", undefined, "knowledge-empty"); n.append(el("h2", heading), el("p", text)); return n; };
      function navigate(next: typeof tab) { tab = next; selectedId = ""; offset = 0; recentCursor = undefined; recentBack.length = 0; renderToolbar(); void load(); }
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
        panel.append(prompt, copy, chat, button("Dismiss", () => panel.remove(), "knowledge-quiet"), feedback); toolbar.after(panel); prompt.focus();
      }
      function renderToolbar() {
        recentTab.setAttribute("aria-pressed", String(!selectedId && tab === "recent")); browseTab.setAttribute("aria-pressed", String(!selectedId && tab === "browse"));
        toolbar.replaceChildren(); browseSearch = undefined; ++suggestGeneration; clearTimeout(timer);
        if (selectedId || tab === "ontology" || tab === "diagnostics" || tab === "browse") return;
        toolbar.append(searchForm());
      }
      function searchForm(compact = false) {
        const form = el("form", undefined, "knowledge-search"), input = el("input"), suggestions = el("div", undefined, "knowledge-suggestions");
        if (compact) form.classList.add("knowledge-search-compact");
        input.type = "search"; input.maxLength = 200; input.placeholder = "Search people, projects, and everything else…"; input.value = query; input.setAttribute("aria-label", "Search knowledge");
        if (compact) input.placeholder = "Search names, aliases, or text";
        const submit = el("button", undefined, "knowledge-search-submit"); submit.type = "submit"; submit.setAttribute("aria-label", "Search all text"); submit.title = "Search all text"; submit.append(query ? icon("cornerDownLeft", 14) : el("kbd", "/"));
        const searchIcon = el("span", undefined, "knowledge-search-icon"); searchIcon.append(icon("search", compact ? 14 : 16));
        form.append(searchIcon, input, submit, suggestions);
        form.onsubmit = event => { event.preventDefault(); query = input.value.trim(); offset = 0; searchSnapshot = undefined; tab = "search"; suggestions.replaceChildren(); renderToolbar(); void load(); };
        input.oninput = () => {
          query = input.value; submit.replaceChildren(query ? icon("cornerDownLeft", 14) : el("kbd", "/")); const token = ++suggestGeneration; clearTimeout(timer); suggestions.replaceChildren();
          if (!query.trim()) return;
          // Exact identity lookup is supported today. Do not present it as prefix search.
          timer = setTimeout(() => { void feature.invoke("lookup", { query: query.trim(), limit: 10 }).then(result => {
            if (disposed || token !== suggestGeneration || !context.host.connection.connected || !form.isConnected) return;
            suggestions.replaceChildren(); if (!result.hits.length) return;
            suggestions.append(el("small", "Exact names and aliases"));
            for (const hit of result.hits) { const item = button(hit.record.title, () => open(hit.record.id), "knowledge-suggestion"); item.prepend(tile(hit.record.type, 24, hit.record.kind)); suggestions.append(item); }
          }).catch(() => {}); }, 200);
        };
        input.onkeydown = event => { if (event.key === "Escape") { ++suggestGeneration; suggestions.replaceChildren(); } };
        return form;
      }
      function summaryLink(r: Summary) { const b = button(r.title, () => open(r.id), "knowledge-record-link"); b.prepend(tile(r.type, 24, r.kind)); if (r.lifecycle !== "active") b.append(chip(human(r.lifecycle))); return b; }
      async function claimCard(r: Summary, n: number, aboutId?: string) {
        const result = await feature.invoke("record", { id: r.id, maxChars: 4000, includeMetadata: true });
        if (!live(n) || !result.record) return undefined;
        return renderClaim(result, n, aboutId);
      }
      function renderClaim(result: Detail, n: number, aboutId?: string, standalone = false) {
        const record = result.record!, card = el("article", undefined, `knowledge-claim${standalone ? " knowledge-claim-standalone" : ""}`); card.dataset.kind = aboutId && !record.metadata?.entities?.includes(aboutId) && record.metadata?.owner === aboutId ? "Owned commitments" : record.claimKind ?? record.kind;
        const row = el("div", undefined, "knowledge-claim-row"), copy = el("div", undefined, "knowledge-claim-copy");
        copy.append(standalone ? el("p", record.body || record.title, "knowledge-claim-text") : button(record.body || record.title, () => open(record.id), "knowledge-claim-text"));
        const metadata = el("div", undefined, "knowledge-claim-meta");
        const assertionOrigin = el("span", origin(record.assertionOrigin), `knowledge-origin knowledge-origin-${record.assertionOrigin ?? "unknown"}`);
        assertionOrigin.prepend(icon(record.assertionOrigin === "source" ? "paperclip" : record.assertionOrigin === "user_belief" ? "circleUser" : record.assertionOrigin === "agent_inference" ? "brain" : "info", 12));
        metadata.append(el("span", label(record.kind === "relationship" ? record.type : record.claimKind ?? "claim")), assertionOrigin);
        if (record.metadata?.due_at) metadata.append(el("span", `Due ${record.metadata.due_at}`));
        if (record.metadata?.occurred_at) metadata.append(el("span", `Occurred ${record.metadata.occurred_at}`));
        copy.append(metadata);
        if (result.content.nextOffset !== null) copy.append(el("small", "Excerpt — open claim for the complete text."));
        row.append(tile(record.kind === "relationship" ? record.type : record.claimKind ?? "claim", 28, record.kind), copy); card.append(row);
        const evidence = el("details", undefined, "knowledge-claim-evidence"), disclosure = el("summary");
        disclosure.append(el("span", `Evidence · ${result.evidenceTotal ?? 0} source files`, "knowledge-sr-only"), icon("chevronDown", 14));
        disclosure.title = "Show evidence and correction options"; evidence.open = standalone; evidence.append(disclosure);
        if (record.assertionOrigin === "agent_inference") evidence.append(el("p", "This is the agent’s inference, not a quoted source statement. Supporting material, if any, is shown below.", "knowledge-notice"));
        const correct = button("Correct in chat", () => ask(record, true), "knowledge-quiet knowledge-correct"); correct.prepend(icon("pencil", 16));
        if (result.evidence?.length) evidence.append(evidenceView(feature, result, () => live(n), errorText, undefined, correct));
        else {
          if (record.attribution) evidence.append(el("p", record.attribution, "knowledge-attribution"));
          evidence.append(el("p", "No source evidence recorded."), correct);
        }
        card.append(evidence); return card;
      }

      async function showDetail(id: string, n: number) {
        const result = await feature.invoke("record", { id, maxChars: 65536, includeMetadata: true, includeReferences: true, referenceLimit: 20 });
        if (!live(n)) return;
        if (!result.record) { content.replaceChildren(empty("Record unavailable", "This record cannot be opened in the current scope. No matching record was selected arbitrarily.")); return; }
        const r = result.record, meta = r.metadata;
        const head = el("header", undefined, "knowledge-entity-header"), heading = el("div");
        heading.append(el("h2", r.title));
        const facts = el("div", undefined, "knowledge-inline-facts"); facts.append(el("span", label(r.type)));
        if (meta?.aliases?.length) { const aliases = el("span", "Also called ", "knowledge-aliases"); for (const alias of meta.aliases) aliases.append(chip(alias)); facts.append(aliases); }
        const fieldNodes = new Map<string, HTMLElement>();
        for (const [name, value] of Object.entries(meta?.fields ?? {})) { const node = el("span", `${human(name)}: ${typeof value === "object" ? JSON.stringify(value) : value}`); fieldNodes.set(name, node); facts.append(node); }
        if (fieldNodes.size) void feature.invoke("ontology", { view: "definitions", name: r.type, limit: 1 }).then(schema => { if (!live(n)) return; for (const field of schema.definitions?.[0]?.fields ?? []) { const node = fieldNodes.get(field.name), value = meta?.fields?.[field.name]; if (node) node.textContent = `${field.label}: ${typeof value === "object" ? JSON.stringify(value) : value}`; } }).catch(() => {});
        const askButton = button("Ask your agent", () => ask(r)); askButton.prepend(icon("messageSquare", 14));
        heading.append(facts); const entityTile = tile(r.type, 48, r.kind); entityTile.classList.remove("knowledge-tile-plain"); head.append(entityTile, heading, askButton);
        const back = button("← Knowledge", () => { selectedId = ""; renderToolbar(); void load(); }, "knowledge-back"); back.setAttribute("aria-label", "← Knowledge"); back.replaceChildren(icon("arrowLeft", 14), el("span", "Knowledge"));
        const breadcrumb = el("nav", undefined, "knowledge-breadcrumb"); breadcrumb.setAttribute("aria-label", "Breadcrumb"); breadcrumb.append(back, icon("chevronRight", 12), el("span", label(r.type)));
        const grid = el("div", undefined, "knowledge-entity-grid"), main = el("div", undefined, "knowledge-entity-main"), aside = el("aside", undefined, "knowledge-entity-aside");
        if (!r.valid) main.append(el("p", "This record has validation issues.", "knowledge-notice"));
        if (r.lifecycle !== "active") main.append(el("p", `${human(r.lifecycle)} — historical knowledge, not a current assertion.`, "knowledge-notice"));
        const lifecycle = meta as Record<string, unknown> | undefined;
        const change = lifecycle?.lifecycle_change;
        if (change && typeof change === "object" && "reason" in change && typeof change.reason === "string") main.append(el("p", change.reason, "knowledge-notice"));
        if (typeof lifecycle?.superseded_by === "string") main.append(button("View replacement →", () => open(lifecycle.superseded_by as string), "knowledge-quiet"));
        if (typeof lifecycle?.supersedes === "string") main.append(button("View original assertion", () => open(lifecycle.supersedes as string), "knowledge-quiet"));
        const body = el("div", undefined, "knowledge-summary");
        // textContent keeps portable Markdown safe; raw Markdown remains in File details.
        for (const paragraph of (r.body ?? "").split(/\n\s*\n/)) body.append(el("p", paragraph));
        body.append(el("span", `Revision ${r.revision}${meta?.updated_at ? ` · updated ${date(meta.updated_at)}` : ""}`, "knowledge-summary-meta"));
        if (r.kind === "page") main.append(body);
        else {
          const statement = el("section", undefined, "knowledge-statement"), surface = el("div", undefined, "knowledge-surface knowledge-claim-groups");
          statement.append(el("h3", r.kind === "claim" ? "Statement & evidence" : "Relationship & evidence"));
          surface.append(renderClaim(result, n, undefined, true));
          statement.append(surface, el("p", `Revision ${r.revision}${meta?.updated_at ? ` · updated ${date(meta.updated_at)}` : ""}`, "knowledge-summary-meta")); main.append(statement);
        }
        if (result.content.nextOffset !== null) main.append(el("p", "Preview is truncated. Open the original Markdown in File details for paged content."));
        const claims = el("section"), connections = el("section"), learned = el("section");
        if (r.kind === "page") { claims.append(el("h3", "What your agent knows")); main.append(claims); }
        connections.append(el("h3", "Connections")); learned.append(el("h3", "Learned in"), el("p", "Conversation not recorded.", "knowledge-muted")); aside.append(connections, learned);
        const files = el("details", undefined, "knowledge-file-details"); const fileSummary = el("summary", "File details"); fileSummary.append(icon("chevronDown", 12)); files.append(fileSummary);
        const filePanel = el("div", undefined, "knowledge-surface knowledge-file-panel"), fileActions = el("div", undefined, "knowledge-file-actions");
        const dl = el("dl"); for (const [label, value] of [["File", r.path], ["ID", r.id], ["Revision", String(r.revision)]]) dl.append(el("dt", label), el("dd", value));
        const checkpointValue = el("dd", "Checking…"); dl.append(el("dt", "History"), checkpointValue); filePanel.append(dl);
        const technical = el("details", undefined, "knowledge-technical-details"); technical.append(el("summary", "Technical metadata"), el("p", `Lifecycle: ${r.lifecycle}`), el("code", `SHA-256: ${r.hash}`), rawBlock("Structured metadata", JSON.stringify(meta, null, 2)));
        const raw = button("View Markdown", () => {
          raw.disabled = true; let next = 0; const text = el("pre"); const more = button("Read more Markdown", () => { void read(); });
          async function read() { more.disabled = true; try { const page = await feature.invoke("record", { id, view: "raw", offset: next, maxChars: 65536 }); if (!live(n)) return; if (page.record?.hash !== r.hash) throw Error("Record changed; reopen it to read the current Markdown."); text.textContent += page.record.raw ?? ""; if (page.content.nextOffset === null) more.remove(); else { next = page.content.nextOffset; more.disabled = false; } } catch (error) { filePanel.append(failure(error)); more.disabled = false; } }
          filePanel.append(text, more); void read();
        }); raw.prepend(icon("fileText", 14));
        const historyList = el("div", undefined, "knowledge-history-list"); historyList.hidden = true;
        const historyButton = button("History", () => { historyList.hidden = !historyList.hidden; historyButton.setAttribute("aria-expanded", String(!historyList.hidden)); }, "knowledge-quiet"); historyButton.prepend(icon("clock", 14)); historyButton.setAttribute("aria-expanded", "false");
        fileActions.append(raw, historyButton); filePanel.append(fileActions, historyList, technical); files.append(filePanel); aside.append(files);
        if (r.kind === "page" && result.evidence?.length) { const sources = el("details"); sources.append(el("summary", `Sources · ${result.evidenceTotal ?? 0}`), evidenceView(feature, result, () => live(n), errorText)); main.append(sources); }
        grid.append(main, aside); content.replaceChildren(breadcrumb, head, grid);
        if (r.kind === "claim" && meta?.entities?.length) {
          const about = el("section", undefined, "knowledge-about"), targets = el("div", undefined, "knowledge-surface knowledge-connections");
          about.append(el("h3", "About"), targets); aside.prepend(about);
          const ids = [...new Set(meta.entities)].slice(0, 20);
          void Promise.all(ids.map(async entityId => result.references?.find(ref => ref.id === entityId) ?? (await feature.invoke("record", { id: entityId, view: "summary" })).record)).then(records => {
            if (!live(n)) return;
            for (const record of records) if (record) { const row = el("div", undefined, "knowledge-connection"); row.append(summaryLink(record)); targets.append(row); }
            if (!targets.children.length) targets.append(el("p", "Linked records are unavailable.", "knowledge-aside-empty"));
            if (meta.entities!.length > ids.length) about.append(el("p", "Showing the first 20 linked entities.", "knowledge-muted"));
          }).catch(error => { if (live(n)) targets.append(failure(error)); });
        }
        const refs = el("div", undefined, "knowledge-surface knowledge-connections"); connections.append(refs);
        const claimSurface = el("div", undefined, "knowledge-surface knowledge-claim-groups"); claims.append(claimSurface);
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
            if (link.direction === "claims" && r.kind === "page") { const card = cards[i]; if (!card) continue; const kind = card.dataset.kind!; let group = claimGroups.get(kind); if (!group) { group = el("div", undefined, "knowledge-claim-group"); group.append(el("h4", label(kind))); claimGroups.set(kind, group); claimSurface.append(group); } group.append(card); const count = group.querySelectorAll(".knowledge-claim").length; group.querySelector("h4")!.textContent = `${({belief:"Opinions",commitment:"Commitments",decision:"Decisions",preference:"Preferences",fact:"Facts",event:"Events"} as Record<string,string>)[kind] ?? label(kind)} · ${count}`; }
            else { const row = el("div", undefined, "knowledge-connection"), target = endpoints[i] ?? link.record;
              const destination = button("", () => open(target.id), "knowledge-connection-link"), copy = el("span", undefined, "knowledge-connection-copy");
              copy.append(el("small", `${link.direction === "incoming" ? "← " : link.direction === "outgoing" ? "" : "Depends on this · "}${label(link.label ?? link.direction)}`), el("span", target.title));
              destination.append(tile(target.type, 24, target.kind), copy); row.append(destination);
              if (endpoints[i]) { const detail = button("", () => open(link.record.id), "knowledge-connection-evidence"); detail.setAttribute("aria-label", "Relationship evidence"); detail.title = "Relationship evidence"; detail.append(icon("paperclip", 13)); row.append(detail); } refs.append(row); }
          }
          if (r.kind === "page") { const count = claims.querySelectorAll(".knowledge-claim").length; const heading = claims.querySelector("h3")!; heading.replaceChildren(document.createTextNode("What your agent knows "), el("span", `${count} ${count === 1 ? "claim" : "claims"}${page.nextOffset !== null ? " shown" : ""}`, "knowledge-section-count")); }
          loadMore.remove(); if (page.nextOffset !== null) { linkOffset = page.nextOffset; connections.append(loadMore); }
          else { if (!refs.children.length) { refs.remove(); connections.append(el("p", "No connections recorded.", "knowledge-muted")); } if (r.kind === "page" && !claimGroups.size) { claimSurface.remove(); claims.append(el("p", "No active linked claims. Tell your agent in chat to add knowledge.")); } }
        }
        const loadMore = button("More claims and connections", () => { loadMore.disabled = true; void moreConnections().catch(error => { connections.append(failure(error)); }).finally(() => { loadMore.disabled = false; }); });
        void moreConnections().catch(error => { if (live(n)) connections.append(failure(error)); });
        if (result.references?.length) { const references = el("details"); references.append(el("summary", "Record references · not asserted relationships")); for (const ref of result.references) references.append(summaryLink(ref)); if (result.nextReferenceOffset != null) references.append(el("p", "Showing the first 20 references.")); technical.append(references); }
        void feature.invoke("history", { id, limit: 10 }).then(history => {
          if (!live(n)) return;
          const checkpoint = history.mutations.find(m => m.hash === r.hash)?.git;
          checkpointValue.textContent = checkpoint ? label(checkpoint.state) : "Not recorded";
          checkpointValue.title = checkpoint?.message ?? "No Git checkpoint recorded for this revision.";
          for (const entry of history.entries) historyList.append(el("p", `Revision ${entry.revision} · ${date(entry.at)} · ${human(entry.provenance)}`));
          if (!history.entries.length) historyList.append(el("p", "No saved history recorded."));
          if (history.nextOffset !== null) historyList.append(el("p", "Showing the latest 10 revisions."));
        }).catch(error => { if (live(n)) { checkpointValue.textContent = "Unavailable"; historyList.append(failure(error)); } });

      }
      async function browse(n: number) {
        const result = await feature.invoke("records", { kind, offset, limit: 50, ...(type ? { type } : {}) });
        if (!live(n)) return;
        const layout = el("div", undefined, "knowledge-browse"), facets = el("nav", undefined, "knowledge-facets"); facets.setAttribute("aria-label", "Types");
        const facet = (name: string, label: string, count?: number) => { const control = button(label, () => { type = name; offset = 0; void load(); }, "knowledge-facet"); control.prepend(name ? tile(name, 20) : el("span", undefined, "knowledge-facet-spacer")); control.setAttribute("aria-pressed", String(type === name)); if (count !== undefined) control.append(el("span", count.toLocaleString(), "knowledge-facet-count")); facets.append(control); };
        facet("", "Everything", kind === "page" && vocabulary ? vocabulary.definitions.reduce((sum, d) => sum + d.recordCount, 0) : !type ? result.total : undefined);
        if (kind === "page" && vocabulary) { let group = ""; for (const def of [...vocabulary.definitions].filter(d => d.recordCount > 0).sort((a, b) => ["entity", "concept", "media", "temporal", "annotation"].indexOf(a.primitive) - ["entity", "concept", "media", "temporal", "annotation"].indexOf(b.primitive))) { if (group !== def.primitive) { group = def.primitive; facets.append(el("h3", ({entity:"People & things",concept:"Ideas & projects",media:"Sources & writing",temporal:"Events & conversations",annotation:"Annotations"} as Record<string,string>)[group] ?? human(group), "knowledge-eyebrow")); } facet(def.name, ({Person:"People",Company:"Companies",Project:"Projects",Concept:"Concepts",Meeting:"Meetings",Note:"Notes",Source:"Sources"} as Record<string,string>)[def.label] ?? def.label, def.recordCount); } facets.append(el("p", `${vocabulary.definitions.filter(d => !d.recordCount).length} empty types hidden`, "knowledge-muted")); }
        const panel = el("div", undefined, "knowledge-surface knowledge-table-wrap"), controls = el("div", undefined, "knowledge-table-toolbar");
        controls.append(browseSearch ??= searchForm(true));
        const kinds = el("div", undefined, "knowledge-kind-switch"); kinds.setAttribute("role", "group"); kinds.setAttribute("aria-label", "Record kind");
        for (const [value, label] of [["page", "Pages"], ["claim", "Claims"], ["relationship", "Connections"]] as const) { const b = button(label, () => { kind = value; type = ""; offset = 0; void load(); }, "knowledge-quiet"); b.setAttribute("aria-pressed", String(kind === value)); kinds.append(b); }
        controls.append(kinds); panel.append(controls);
        if (kind === "claim") { const cards = await Promise.all(result.records.map(r => claimCard(r, n))); if (!live(n)) return; for (const card of cards) if (card) panel.append(card); }
        else { const table = el("table", undefined, "data-table knowledge-table"), head = el("thead"), row = el("tr"); for (const label of ["Name", "Type", "Status"]) row.append(el("th", label)); head.append(row); table.append(head); const body = el("tbody"); for (const record of result.records) { const row = el("tr"), name = el("td"); name.append(summaryLink(record)); row.append(name, el("td", label(record.type)), el("td", record.valid ? human(record.lifecycle) : "Needs attention")); body.append(row); } table.append(body); panel.append(table); }
        if (!result.records.length) panel.append(empty("Nothing here yet", "Tell your agent in chat and saved knowledge will appear here."));
        const pages = el("div", undefined, "knowledge-pagination");
        const capped = result.nextOffset !== null && result.nextOffset > 500;
        pages.append(el("span", `${result.total ? offset + 1 : 0}–${offset + result.records.length} of ${result.total.toLocaleString()} · ${result.total > 550 ? "partial browse access" : "complete inventory, paginated"}`));
        const previous = button("Previous", () => { offset = Math.max(0, offset - 50); void load(); }); previous.disabled = !offset;
        const next = button("Next", () => { offset = result.nextOffset!; void load(); }); next.disabled = result.nextOffset === null || capped; pages.append(previous, next); panel.append(pages);
        if (capped) panel.append(el("p", "This server cannot page beyond 550 records. Narrow the type filter to see more.", "knowledge-notice"));
        const results = el("div", undefined, "knowledge-browse-results"); results.append(panel); layout.append(facets, results); content.replaceChildren(layout);
      }
      async function recent(n: number) {
        const activity = await feature.invoke("recent", { limit: 20, ...recentCursor }); if (!live(n)) return;
        const feed = el("div", undefined, "knowledge-feed");
        let currentDay = "", group: HTMLElement | undefined;
        for (const entry of activity.items) {
          const day = new Date(entry.at).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
          if (day !== currentDay) {
            currentDay = day;
            feed.append(el("h2", new Date(entry.at).toDateString() === new Date().toDateString() ? "Today" : day, "knowledge-eyebrow"));
            group = el("section", undefined, "knowledge-surface"); feed.append(group);
          }
          const lifecycle = entry.change === "corrected" || entry.change === "withdrawn";
          const row = el("article", undefined, "knowledge-feed-item"); row.dataset.change = entry.change;
          const copy = el("span", undefined, "knowledge-feed-copy");
          const kindLabel = entry.kind === "relationship" ? "Connection" : label(entry.type);
          const time = new Date(entry.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
          const badgeLabel = ({created:"New", updated:"Updated", observed:"Observed", external:"Edited", corrected:"Corrected", withdrawn:"Withdrawn"})[entry.change];
          const badge = chip(badgeLabel); if (entry.change === "created") badge.classList.add("knowledge-chip-new");
          copy.append(el("span", entry.title || `${kindLabel} ${entry.change}`, "knowledge-feed-title"));
          const description = entry.change === "corrected" ? `${kindLabel} · Corrected` : entry.change === "withdrawn" ? `${kindLabel} · Withdrawn` : entry.change === "external" ? `${kindLabel} · Edited outside OpenClaw` : kindLabel;
          copy.append(el("span", `${description} · ${time}`, "knowledge-feed-meta"));
          if (lifecycle) {
            row.classList.add("knowledge-activity-event");
            const disclosure = el("details", undefined, "knowledge-activity-details"), summary = el("summary", undefined, "knowledge-activity-summary");
            disclosure.open = recentExpanded.has(entry.sequence);
            disclosure.ontoggle = () => { if (disclosure.isConnected) { if (disclosure.open) recentExpanded.add(entry.sequence); else recentExpanded.delete(entry.sequence); } };
            summary.append(tile(entry.type, 28, entry.kind), copy, badge, icon("chevronDown", 14));
            const detail = el("div", undefined, "knowledge-activity-body");
            const explanation = entry.change === "withdrawn"
              ? "This is no longer used as current knowledge. You can still read it in history."
              : entry.replacementActive
                ? "A corrected version is now used instead. The earlier version is kept in history."
                : "A corrected version was saved, but it is no longer current either. Both versions are kept in history.";
            detail.append(el("p", explanation, "knowledge-activity-reason"));
            const links = el("div", undefined, "knowledge-activity-links");
            links.append(button(entry.change === "corrected" ? "View original" : "View history", () => open(entry.id), "knowledge-quiet"));
            if (entry.replacementId) links.append(button(entry.replacementActive ? "View replacement" : "View replacement history", () => open(entry.replacementId!), "knowledge-quiet"));
            detail.append(links); disclosure.append(summary, detail); row.append(disclosure);
            if (entry.reason) {
              const reason = el("details", undefined, "knowledge-activity-audit");
              reason.append(el("summary", "Recorded reason"), el("p", entry.reason, "knowledge-activity-reason"));
              detail.append(reason);
            }
          } else {
            const item = button("", () => open(entry.id), "knowledge-feed-link");
            item.append(tile(entry.type, 28, entry.kind), copy); row.append(item, badge);
          }
          group!.append(row);
        }
        if (!activity.items.length) feed.append(empty("No recent activity", "Knowledge saved by your agent will appear here. Earlier revisions remain in each record’s history."));
        const pages = el("div", undefined, "knowledge-pagination");
        if (recentBack.length) pages.append(button("Newer activity", () => { recentCursor = recentBack.pop(); void load(); }));
        if (activity.nextBefore !== null) pages.append(button("Older activity", () => { recentBack.push(recentCursor); recentCursor = { upperSequence: activity.upperSequence, beforeSequence: activity.nextBefore! }; void load(); }));
        feed.append(pages); content.replaceChildren(feed);
      }
      async function load() {
        const n = ++generation; if (vaultChanged) return;
        if (!context.host.connection.connected) { content.replaceChildren(empty("Disconnected", "Reconnect to read your agent’s knowledge.")); return; }
        content.replaceChildren(el("p", "Loading…", "knowledge-muted"));
        try {
          if (selectedId) return await showDetail(selectedId, n);
          if (tab === "recent") return await recent(n);
          if (tab === "browse") return await browse(n);
          if (tab === "ontology") { const result = await loadVocabulary(feature, true); if (live(n)) content.replaceChildren(button("← Knowledge", () => navigate("recent"), "knowledge-quiet"), button("Vault status", () => navigate("diagnostics"), "knowledge-quiet"), ontologyView(result, open, () => navigate("diagnostics"))); return; }
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
        if (!context.host.connection.connected) { status.textContent = "Disconnected"; status.dataset.live = "false"; void load(); return; }
        try {
          const report = await feature.invoke("status", {}); if (disposed || n !== statusGeneration || !context.host.connection.connected) return;
          const nextIdentity = JSON.stringify([report.agent, report.vault, report.scope]);
          if (identity && identity !== nextIdentity) { vaultChanged = true; ++generation; ++suggestGeneration; toolbar.replaceChildren(); root.querySelector(".knowledge-chat-handoff")?.remove(); status.textContent = "Vault changed"; status.dataset.live = "false"; content.replaceChildren(empty("Vault changed", "Reload this page to open the newly connected vault.")); return; }
          identity = nextIdentity; agentId = report.agent;
          status.textContent = report.live === "watching" ? "Live" : "Periodic refresh"; status.dataset.live = String(report.live === "watching");
          banner.hidden = !report.sample; banner.textContent = report.sample ? "Sample vault · Fictional people and projects. Your private knowledge is not connected." : "";
          vocabulary = await loadVocabulary(feature); if (disposed || n !== statusGeneration) return;
          const pageCount = vocabulary.definitions.reduce((sum, d) => sum + d.recordCount, 0);
          const countBadge = el("span", pageCount.toLocaleString(), "knowledge-tab-count"); countBadge.setAttribute("aria-hidden", "true"); browseTab.replaceChildren(document.createTextNode("Browse"), countBadge);
          void load();
        } catch (error) { if (!disposed && n === statusGeneration) { status.textContent = "Unavailable"; status.dataset.live = "false"; content.replaceChildren(failure(error)); } }
      }
      let connected = context.host.connection.connected;
      const unsubscribe = context.host.subscribe(() => { if (connected !== context.host.connection.connected) { connected = context.host.connection.connected; ++suggestGeneration; toolbar.querySelector(".knowledge-suggestions")?.replaceChildren(); void refresh(); } });
      const unwatch = feature.on("changed", () => void refresh());
      const resync = setInterval(() => { if (context.host.connection.connected && !document.hidden) void refresh(); }, 30000);
      const focusSearch = (event: KeyboardEvent) => { if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || (event.target instanceof HTMLElement && event.target.isContentEditable)) return; const input = root.querySelector<HTMLInputElement>("input[type=search]"); if (input) { event.preventDefault(); input.focus(); } };
      document.addEventListener("keydown", focusSearch);
      renderToolbar(); void refresh();
      return { dispose() { document.removeEventListener("keydown", focusSearch); disposed = true; ++generation; ++statusGeneration; ++suggestGeneration; clearTimeout(timer); clearInterval(resync); unwatch(); unsubscribe(); root.remove(); } };
    } });
    return () => { removePage(); removeNavigation(); };
  },
});
