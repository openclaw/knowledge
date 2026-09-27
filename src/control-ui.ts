import { defineControlUiPlugin } from "openclaw/plugin-sdk/control-ui";
import { createFeatureClient, type FeatureOutput } from "openclaw/plugin-sdk/feature-contract";
import { contract } from "./contract.js";
import { evidenceView, originalDownload } from "./evidence-view.js";
import { loadVocabulary } from "./inspection-client.js";
import { ontologyView } from "./ontology-view.js";
import { icon, type IconName } from "./ui-icons.js";
import { confidenceView, identityTag, assertionOrigin as origin, agentDisplayName } from "./knowledge-presentation.js";
import { formatSourceDate, sourceDateNote } from "./temporal.js";
import { captureReadingState } from "./reading-state.js";
import { markdownView } from "./markdown-view.js";
import "./control-ui.css";

type Summary = FeatureOutput<typeof contract, "records">["records"][number];
type Detail = FeatureOutput<typeof contract, "record">;
type ClaimPresentation = {
  record: Omit<NonNullable<Detail["record"]>, "metadata"> & { metadata?: Partial<NonNullable<NonNullable<Detail["record"]>["metadata"]>> };
  truncated: boolean;
  evidenceTotal?: number;
  evidenceSourceTotal?: number;
};
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n; };
const button = (text: string, run: () => void, className = "knowledge-button") => { const n = el("button", text, className); n.type = "button"; n.onclick = run; return n; };
const chip = (text: string) => el("span", text, "chip knowledge-chip");
const human = (text: string) => text.replaceAll("_", " ").replaceAll("-", " ");
const label = (text: string) => human(text).replace(/^./, c => c.toUpperCase());
const typeIcons: Record<string, [IconName, string]> = { person: ["circleUser", "teal"], company: ["box", "blue"], organization: ["box", "blue"], project: ["kanban", "green"], concept: ["spark", "amber"], meeting: ["users", "red"], email: ["mail", "neutral"], source: ["paperclip", "neutral"], decision: ["flag", "neutral"], commitment: ["listChecks", "neutral"], preference: ["star", "neutral"], fact: ["info", "neutral"], belief: ["brain", "neutral"], event: ["calendarClock", "neutral"] };
const tile = (type: string, size = 28, kind = "page") => { const [glyph, tone] = (Object.hasOwn(typeIcons, type) ? typeIcons[type] : undefined) ?? [kind === "relationship" ? "link" : "fileText", "neutral"]; const n = el("span", undefined, `knowledge-tile knowledge-tone-${tone}${kind === "page" ? "" : " knowledge-tile-plain"}`); n.style.setProperty("--tile-size", `${size}px`); n.append(icon(glyph, size >= 48 ? 24 : size <= 24 ? 13 : 15)); return n; };
const date = (text: string) => formatSourceDate(text);
const time = (text: string) => new Date(text).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZoneName: "short" });

/** Summary label whose text swaps with its details element's open state. */
const disclosureLabel = (closed: string, opened: string) => { const control = el("span", undefined, "knowledge-disclosure-label"); control.append(el("span", closed, "knowledge-when-closed"), el("span", opened, "knowledge-when-open"), icon("chevronDown", 14)); return control; };
/** Drop a leading `# Title` heading that repeats the page title shown in the entity header. */
const withoutTitleHeading = (body: string, title: string) => { const match = /^\s*#[ \t]+(.+?)[ \t#]*(?:\r?\n|$)/.exec(body); return match && match[1].trim() === title.trim() ? body.slice(match[0].length).replace(/^\s*\n/, "") : body; };
/** Page bodies longer than this preview behind "Show full notes". */
const longBodyChars = 3000;
/** Claim text for compact rows: wikilinks read as their labels, since a row is one button. */
const plainLinks = (text: string) => text.replace(/\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g, (_, target: string, label?: string) => (label ?? target).trim());
/** Short file kind for a retained original, from its recorded media type or extension. */
const fileKind = (e: { mediaType?: string; filename?: string; path: string }) => {
  const kinds: Record<string, string> = { "text/plain": "Text", "text/markdown": "Markdown", "application/json": "JSON", "application/pdf": "PDF", "text/html": "HTML", "text/csv": "CSV" };
  const media = e.mediaType?.split(";")[0].trim().toLowerCase();
  return (media && kinds[media]) ?? (e.filename ?? e.path).split(".").at(-1)?.toUpperCase() ?? "File";
};
/** Human-scale byte count, e.g. "49 KB". */
const fileSize = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const rawBlock = (label: string, text: string) => { const n = el("details"); n.append(el("summary", label), el("pre", text)); return n; };

export default defineControlUiPlugin({
  id: contract.pluginId,
  activate(host) {
    const removeNavigation = host.ui.registerNavigation({ id: "knowledge", label: "Knowledge", page: { id: "overview" }, icon: "book" });
    const removePage = host.ui.registerPage({ id: "overview", label: "Knowledge", mount(container, context) {
      const feature = createFeatureClient(contract, context.host);
      const root = el("section", undefined, "knowledge-page"), header = el("header", undefined, "knowledge-header"), title = el("div"), actions = el("div", undefined, "knowledge-actions");
      const subtitle = el("p"); title.append(el("h1", "Knowledge"), subtitle);
      const status = el("span", "Connecting…", "knowledge-status"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
      const vocabularyButton = button("", () => navigate("ontology"), "knowledge-icon-button"); vocabularyButton.setAttribute("aria-label", "Vocabulary"); vocabularyButton.title = "Ontology & vault settings"; vocabularyButton.append(icon("book"));
      const sampleChip = chip("Sample vault"); sampleChip.hidden = true; actions.append(sampleChip, status, vocabularyButton);
      const nav = el("nav", undefined, "knowledge-tabs"); nav.setAttribute("aria-label", "Knowledge views");
      // These are text navigation tabs, not host .btn controls. Theme-specific
      // .btn rules otherwise reintroduce filled backgrounds in light mode.
      const recentTab = button("Recent", () => navigate("recent"), "knowledge-tab"), browseTab = button("Browse", () => navigate("browse"), "knowledge-tab"); nav.append(recentTab, browseTab);
      const banner = el("p", "", "knowledge-notice"), toolbar = el("div", undefined, "knowledge-toolbar"), content = el("div", undefined, "knowledge-content");
      header.append(title, nav, actions);
      const body = el("div", undefined, "knowledge-page-body"); const loading = el("div", "", "knowledge-loading knowledge-muted"); loading.hidden = true; loading.setAttribute("role", "status"); loading.setAttribute("aria-live", "polite");
      body.append(banner, toolbar, loading, content);
      root.append(header, body); container.append(root);
      let tab: "recent" | "browse" | "search" | "ontology" | "diagnostics" = "recent", selectedId = "", query = "", kind: "page" | "claim" | "relationship" = "page", type = "", offset = 0;
      type RecentCursor = { upperSequence: number; beforeSequence: number } | undefined;
      let recentCursor: RecentCursor;
      let includeHistory = false, browseQuery = "", originFilter = "";
      let recentSequence = 0, lastChecked = "", pendingSnapshot: string | undefined;
      const updates = button("", () => { updates.hidden = true; void load(true).then(ok => { if (ok) { snapshot = pendingSnapshot; pendingSnapshot = undefined; } }); }, "knowledge-new-saves"); updates.hidden = true; toolbar.after(updates);
      const recentBack: RecentCursor[] = [];
      const recentExpanded = new Set<number | string>();
      let generation = 0, statusGeneration = 0, disposed = false, identity = "", vaultChanged = false, agentId = "";
      const agentName = (id = agentId) => agentDisplayName(id, context.host.agents.rows);
      const askLabel = () => `Ask ${agentName() ?? "your agent"}`;
      const searchPlaceholder = () => `Find a person, project, or anything ${agentName() ?? "your agent"} saved…`;
      // Header copy names the configured agent; rerun when its identity or name changes.
      const renderAgentCopy = () => { subtitle.textContent = `What ${agentName() ?? "your agent"} has saved, and where it came from.`; const input = root.querySelector<HTMLInputElement>(".knowledge-search:not(.knowledge-search-compact) input"); if (input) input.placeholder = searchPlaceholder(); };
      let searchSnapshot: string | null | undefined;
      let displayGeneration = 0, viewReady = false, snapshot: string | undefined;
      let staging: HTMLElement | undefined;
      let loadingGeneration = 0, displayView = "", displayScreen = "";
      const viewKey = () => JSON.stringify([tab, selectedId, kind, type, offset, includeHistory, browseQuery, originFilter, query, recentCursor]);
      let connectionPages = 1;
      const evidenceLoaders = new WeakMap<HTMLDetailsElement, () => Promise<void>>();
      let timer: ReturnType<typeof setTimeout> | undefined, suggestGeneration = 0;
      let vocabulary: Awaited<ReturnType<typeof loadVocabulary>> | undefined;
      const live = (n: number) => !disposed && !context.signal.aborted && !vaultChanged && (n === generation || n === displayGeneration) && context.host.connection.connected;
      const errorText = (error: unknown) => context.host.redact(error instanceof Error ? error.message : String(error));
      const failure = (error: unknown) => el("p", errorText(error), "knowledge-error");
      const empty = (heading: string, text: string) => { const n = el("div", undefined, "knowledge-empty"); n.append(el("h2", heading), el("p", text)); return n; };
      function navigate(next: typeof tab) { updates.hidden = true; pendingSnapshot = undefined; tab = next; selectedId = ""; offset = 0; recentCursor = undefined; recentBack.length = 0; renderToolbar(); void load(); }
      function open(id: string) { updates.hidden = true; pendingSnapshot = undefined; selectedId = id; renderToolbar(); void load(); }
      function ask(record: Pick<NonNullable<Detail["record"]>, "id" | "title" | "kind" | "revision" | "hash">, correct = false, candidate?: { id: string; title: string }) {
        root.querySelector(".knowledge-chat-handoff")?.remove();
        const previousFocus = document.activeElement as HTMLElement | null;
        const panel = el("dialog", undefined, "knowledge-chat-handoff knowledge-surface");
        panel.setAttribute("aria-label", candidate ? `${askLabel()} to check this match` : correct ? `${askLabel()} to correct this` : askLabel());
        panel.append(el("h3", panel.getAttribute("aria-label")!), el("p", "Copy the request, open chat, paste it, then review and send. Nothing is sent or changed from here."));
        const prompt = el("textarea"); prompt.readOnly = true; prompt.rows = 9; prompt.setAttribute("aria-label", "Chat request");
        const request = candidate ? `Is "${record.title}" the same person as "${candidate.title}"? Check the evidence on both pages. Link them only if it supports that; don't merge on the handle alone.` : correct ? "Please check this saved claim against its evidence and correct or withdraw it if the evidence supports that.\n\nWhat I think is wrong: " : `What do you know about "${record.title}", and where did it come from?`;
        prompt.value = `${request}\n\nRecord: ${record.title}\nID: ${record.id}\nRevision: ${record.revision}\nHash: ${record.hash}${candidate ? `\nCandidate: ${candidate.id}` : ""}`;
        prompt.onclick = () => prompt.select();
        const feedback = el("p"); feedback.setAttribute("role", "status");
        const copy = button("Copy request", () => { void navigator.clipboard.writeText(prompt.value).then(() => { copy.textContent = "Copied"; feedback.textContent = "Copied. Nothing has been sent."; }).catch(() => { prompt.select(); feedback.textContent = "Select and copy the request above."; }); });
        const chat = button("Open chat", () => {
          chat.disabled = true;
          void (async () => { const key = await context.host.sessions.create({ agentId: agentId || undefined }); if (key) context.host.sessions.open({ sessionKey: key, agentId: agentId || undefined }); else feedback.textContent = "Chat was not opened. Your request is still here."; })().catch(error => { feedback.textContent = errorText(error); }).finally(() => { chat.disabled = false; });
        });
        const dismiss = () => { panel.close(); panel.remove(); previousFocus?.focus(); };
        panel.oncancel = event => { event.preventDefault(); dismiss(); };
        const footer = el("div", undefined, "knowledge-actions"); footer.append(button("Cancel", dismiss, "knowledge-quiet"), copy, chat);
        panel.append(prompt, el("p", `The ID, revision and hash let ${agentName() ?? "your agent"} confirm it’s looking at the same version you are.`, "knowledge-muted"), footer, feedback); root.append(panel); panel.showModal(); prompt.focus();
      }
      function renderToolbar() {
        recentTab.setAttribute("aria-pressed", String(!selectedId && tab === "recent")); browseTab.setAttribute("aria-pressed", String(!selectedId && tab === "browse"));
        toolbar.replaceChildren(); ++suggestGeneration; clearTimeout(timer);
        if (selectedId || tab === "ontology" || tab === "diagnostics" || tab === "browse") return;
        toolbar.append(searchForm());
      }
      function searchForm(compact = false) {
        const form = el("form", undefined, "knowledge-search"), input = el("input"), suggestions = el("div", undefined, "knowledge-suggestions");
        if (compact) form.classList.add("knowledge-search-compact");
        input.type = "search"; input.maxLength = 200; input.placeholder = searchPlaceholder(); input.value = query; input.setAttribute("aria-label", "Search knowledge");
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
            suggestions.replaceChildren();
            suggestions.append(el("small", "Exact matches"));
            if (!result.hits.length) suggestions.append(el("p", `No page is named exactly "${query}".`));
            for (const hit of result.hits) { const item = button(hit.record.title, () => open(hit.record.id), "knowledge-suggestion"); item.prepend(tile(hit.record.type, 24, hit.record.kind)); item.append(identityTag(hit.record.identityStatus)); suggestions.append(item); }
            suggestions.append(button(`Search all text for "${query}" · ranked`, () => form.requestSubmit(), "knowledge-suggestion"));
          }).catch(() => {}); }, 200);
        };
        input.onkeydown = event => { if (event.key === "Escape") { ++suggestGeneration; suggestions.replaceChildren(); } };
        return form;
      }
      function summaryLink(r: Summary) { const b = button("", () => open(r.id), "knowledge-record-link"); b.title = r.title; b.append(el("span", r.title, "knowledge-record-title")); b.prepend(tile(r.type, 24, r.kind)); b.append(identityTag(r.identityStatus)); if (r.lifecycle !== "active") b.append(chip(human(r.lifecycle))); return b; }
      function claimCard(r: Summary, n: number, aboutId?: string) {
        if (!r.card) return undefined;
        return renderClaim({ record: { ...r, ...r.card }, truncated: r.card.truncated, evidenceTotal: r.card.evidenceTotal, evidenceSourceTotal: r.card.evidenceSourceTotal }, n, aboutId);
      }
      function renderClaim(result: ClaimPresentation, n: number, aboutId?: string, detail?: Detail) {
        const standalone = Boolean(detail);
        const record = result.record!, card = el("article", undefined, `knowledge-claim${standalone ? " knowledge-claim-standalone" : ""}`); card.dataset.kind = aboutId && !record.metadata?.entities?.includes(aboutId) && record.metadata?.owner === aboutId ? "Owned commitments" : record.claimKind ?? record.kind;
        card.dataset.readingKey = `claim:${record.id}`;
        card.dataset.preserveSignature = JSON.stringify([record.hash, record.valid, record.owner, record.source, record.writtenByAgentId ? agentName(record.writtenByAgentId) : undefined]);
        const row = el("div", undefined, "knowledge-claim-row"), copy = el("div", undefined, "knowledge-claim-copy");
        const statement = standalone ? markdownView(record.body || record.title, open, detail?.links) : undefined;
        if (statement) statement.classList.add("knowledge-claim-text");
        copy.append(statement ?? (record.metadata?.source_event && record.source ? button(`Meeting: ${record.source.title}`, () => open(record.source!.id), "knowledge-claim-text") : button(plainLinks(record.body || record.title), () => open(record.id), "knowledge-claim-text")));
        const metadata = el("div", undefined, "knowledge-claim-meta");
        const assertionOrigin = el("span", origin(record.assertionOrigin, record.attribution, record.writtenByAgentId ? agentName(record.writtenByAgentId) : undefined), `knowledge-origin knowledge-origin-${record.assertionOrigin ?? "unknown"}`);
        assertionOrigin.prepend(icon(record.assertionOrigin === "source" ? "paperclip" : record.assertionOrigin === "user_belief" ? "circleUser" : record.assertionOrigin === "agent_inference" ? "brain" : "info", 12));
        if (record.metadata?.supersedes) { const corrected = el("span", "Corrected", "knowledge-state-note"); corrected.prepend(icon("repeat", 12)); metadata.append(corrected); }
        if (record.metadata?.continuity?.length) metadata.append(el("span", record.metadata.continuity.some(link => link.relation === "contradicts") ? "Conflicting account" : "Reaffirmed"));
        // "From source" is the norm, so compact rows show only notable origins;
        // the expanded details still state it.
        const originInMeta = standalone || record.assertionOrigin !== "source";
        metadata.append(el("span", label(record.kind === "relationship" ? record.type : record.claimKind ?? "claim")));
        if (originInMeta) metadata.append(assertionOrigin);
        if (record.owner) { const owner = el("span", "Owner "); owner.append(button(record.owner.title, () => open(record.owner!.id), "knowledge-inline-link")); metadata.append(owner); }
        else if (record.claimKind === "commitment") metadata.append(el("span", "Owner not identified"));


        if (record.about?.length && !(record.metadata?.entities?.length === 1 && record.metadata.entities[0] === aboutId)) { const about = el("span", "About ", "knowledge-claim-about"); for (const entity of record.about) about.append(button(entity.title, () => open(entity.id), "knowledge-inline-link")); metadata.append(about); }
        copy.append(metadata);
        if (result.truncated) copy.append(el("small", "Excerpt — open claim for the complete text."));
        row.append(tile(record.kind === "relationship" ? record.type : record.claimKind ?? "claim", 28, record.kind), copy); card.append(row);
        const evidence = el("details", undefined, "knowledge-claim-evidence"), disclosure = el("summary");
        disclosure.append(el("span", `Evidence · ${result.evidenceSourceTotal ?? "?"} ${result.evidenceSourceTotal === 1 ? "file" : "files"} · ${result.evidenceTotal ?? 0} ${result.evidenceTotal === 1 ? "citation" : "citations"}`, "knowledge-sr-only"), icon("chevronDown", 14));
        disclosure.title = "Show evidence and correction options"; evidence.open = standalone; evidence.append(disclosure);
        const evidenceBody = el("div"); evidence.append(evidenceBody);
        const alive = () => !disposed && !vaultChanged && !context.signal.aborted && context.host.connection.connected && (card.isConnected || (live(n) && Boolean(staging?.contains(card))));
        const showEvidence = (loaded: Detail) => {
          evidenceBody.replaceChildren();
          const details = el("dl", undefined, "knowledge-claim-details"), m = loaded.record?.metadata;
          const field = (name: string, value: string | HTMLElement) => { const dd = el("dd"); dd.append(value); details.append(el("dt", name), dd); };
          if (record.claimKind === "commitment") { field("Owner", record.owner ? button(record.owner.title, () => open(record.owner!.id), "knowledge-inline-link") : "Owner not identified"); field("Deadline", m?.due_at ? formatSourceDate(m.due_at) : "No deadline recorded"); }
          field("Source", record.source ? button(record.source.title, () => open(record.source!.id), "knowledge-inline-link") : record.assertionOrigin === "user_belief" ? "Conversation not recorded" : "Source page not recorded");
          const about = el("span", undefined, "knowledge-claim-about"); for (const id of m?.entities ?? []) { const ref = loaded.references?.find(ref => ref.id === id); about.append(button(ref?.title ?? id, () => open(id), "knowledge-inline-link")); }
          if (about.childNodes.length) field("About", about);
          if (!originInMeta) field("Origin", origin(record.assertionOrigin, record.attribution));
          field("Saved", `${record.recordedAt ? date(record.recordedAt) : "Time not recorded"} · revision ${record.revision}`); evidenceBody.append(details);
          if (record.assertionOrigin === "agent_inference") evidenceBody.append(el("p", "No direct quote for this inference. Premises below.", "knowledge-notice"));
          const correct = button("Correct in chat", () => ask(record, true), "knowledge-quiet knowledge-correct"); correct.prepend(icon("pencil", 16));
          if (loaded.evidence?.some(e => !e.verified) && !metadata.querySelector(".knowledge-unverified")) metadata.append(el("span", "Source file unavailable", "knowledge-unverified"));
          if (loaded.evidence?.length) evidenceBody.append(evidenceView(feature, loaded, alive, errorText, undefined, record.lifecycle === "active" ? correct : undefined));
          else {
            if (record.attribution) evidenceBody.append(el("p", record.attribution, "knowledge-attribution"));
            evidenceBody.append(el("p", "No source evidence recorded.")); if (record.lifecycle === "active") evidenceBody.append(correct);
          }
          if (loaded.relatedStatements?.length) {
            const related = el("section", undefined, "knowledge-related"); related.append(el("h4", "Related statements"));
            for (const link of loaded.relatedStatements) { const row = el("div", undefined, "knowledge-related-row"); const verb = link.relation === "contradicts" ? "Conflicts with" : link.relation === "updates" ? link.incoming ? "Updated by" : "Updates" : link.incoming ? "Reaffirmed by" : "Reaffirms"; row.append(el("strong", verb), button(link.text || link.record.title, () => open(link.record.id), "knowledge-quiet"), el("small", origin(link.assertionOrigin, link.attribution, link.record.writtenByAgentId ? agentName(link.record.writtenByAgentId) : undefined)), el("p", `${link.basis}${link.source ? ` From ${link.source.title}.` : ""}`)); related.append(row); } evidenceBody.append(related);
          }
          if (!standalone) evidenceBody.append(button("Open claim", () => open(record.id), "knowledge-quiet"));
        };
        let loaded = Boolean(detail), loading = false;
        if (detail) showEvidence(detail);
        const loadEvidence = async () => {
          if (loaded || loading || !alive()) return;
          loading = true; evidenceBody.replaceChildren(el("p", "Loading evidence…", "knowledge-muted"));
          try {
            const detail = await feature.invoke("record", { id: record.id, view: "summary", includeEvidence: true, includeMetadata: true, includeReferences: true });
            if (!alive()) return;
            if (!detail.record || detail.record.hash !== record.hash) throw Error("Claim changed or is unavailable; reopen it to refresh evidence.");
            showEvidence(detail); loaded = true;
          } catch (error) {
            if (alive()) evidenceBody.replaceChildren(failure(error), button("Retry evidence", () => { void loadEvidence(); }, "knowledge-quiet"));
          } finally { loading = false; }
        };
        evidenceLoaders.set(evidence, loadEvidence);
        evidence.ontoggle = () => { if (evidence.open) void loadEvidence(); };
        card.append(evidence); return card;
      }

      async function showDetail(id: string, n: number, target: HTMLElement, pages = 1, waitForPanels = false) {
        const pending: Promise<unknown>[] = [];
        const result = await feature.invoke("record", { id, maxChars: 65536, includeMetadata: true, includeReferences: true, referenceLimit: 20 });
        if (!live(n)) return;
        if (!result.record) { target.replaceChildren(empty("Record unavailable", "This record cannot be opened in the current scope. No matching record was selected arbitrarily.")); return; }
        const r = result.record, meta = r.metadata;
        const head = el("header", undefined, "knowledge-entity-header"), heading = el("div");
        heading.append(el("h2", r.title));
        const occurred = r.occurredAt ?? meta?.occurred_at ?? (typeof meta?.fields?.occurred_at === "string" ? meta.fields.occurred_at : undefined);
        if (occurred) { heading.append(el("p", `Occurred ${formatSourceDate(occurred)}`, "knowledge-occurred")); const note = sourceDateNote(occurred); if (note) heading.append(el("p", note, "knowledge-muted")); }
        const facts = el("div", undefined, "knowledge-inline-facts"); facts.append(el("span", label(r.type)));
        if (meta?.aliases?.length) { const aliases = el("span", "Also called ", "knowledge-aliases"); for (const alias of meta.aliases) aliases.append(chip(alias)); facts.append(aliases); }
        facts.append(identityTag(meta?.identity?.status));
        if (meta?.identity?.context) facts.append(el("span", `Context ${meta.identity.context}`));
        const fieldNodes = new Map<string, HTMLElement>();
        for (const [name, value] of Object.entries(meta?.fields ?? {})) { if (name === "occurred_at" || value === "" || value == null) continue; const node = el("span", `${human(name)}: ${name === "occurred_at" && typeof value === "string" ? formatSourceDate(value) : typeof value === "object" ? JSON.stringify(value) : value}`); fieldNodes.set(name, node); facts.append(node); }
        if (fieldNodes.size) pending.push(feature.invoke("ontology", { view: "definitions", name: r.type, limit: 1 }).then(schema => { if (!live(n)) return; for (const field of schema.definitions?.[0]?.fields ?? []) { const node = fieldNodes.get(field.name), value = meta?.fields?.[field.name]; if (node) node.textContent = `${field.label}: ${field.name === "occurred_at" && typeof value === "string" ? formatSourceDate(value) : typeof value === "object" ? JSON.stringify(value) : value}`; } }).catch(() => {}));
        const askButton = button(askLabel(), () => ask(r)); askButton.prepend(icon("messageSquare", 14));
        heading.append(facts); if (r.type === "person" && meta?.identity?.context) heading.append(el("p", `“${meta.identity.context}” is how the source describes them. It isn’t recorded as a role or employer.`, "knowledge-muted")); const entityTile = tile(r.type, 48, r.kind); entityTile.classList.remove("knowledge-tile-plain"); head.append(entityTile, heading, askButton);
        const back = button("← Knowledge", () => { selectedId = ""; renderToolbar(); void load(); }, "knowledge-back"); back.setAttribute("aria-label", "← Knowledge"); back.replaceChildren(icon("arrowLeft", 14), el("span", "Knowledge"));
        const breadcrumb = el("nav", undefined, "knowledge-breadcrumb"); breadcrumb.setAttribute("aria-label", "Breadcrumb"); breadcrumb.append(back, icon("chevronRight", 12), el("span", label(r.type)));
        const grid = el("div", undefined, "knowledge-entity-grid"), main = el("div", undefined, "knowledge-entity-main"), aside = el("aside", undefined, "knowledge-entity-aside");
        if (!r.valid) main.append(el("p", "This record has validation issues.", "knowledge-notice"));
        if (r.lifecycle !== "active") { head.classList.add("knowledge-historical"); main.append(el("p", `Viewing history · ${r.lifecycle === "withdrawn" ? "Withdrawn" : "Replaced"}${meta?.lifecycle_change?.at ? ` ${date(meta.lifecycle_change.at)}` : ""}. ${r.lifecycle === "withdrawn" ? "Not used in search, connections or answers." : "An earlier version. Search and answers use the current one."}`, "knowledge-notice")); askButton.remove(); }
        const lifecycle = meta as Record<string, unknown> | undefined;
        const change = lifecycle?.lifecycle_change;
        if (change && typeof change === "object" && "reason" in change && typeof change.reason === "string") main.append(el("p", change.reason, "knowledge-notice"));
        if (typeof lifecycle?.superseded_by === "string") main.append(button("View replacement →", () => open(lifecycle.superseded_by as string), "knowledge-quiet"));
        if (typeof lifecycle?.supersedes === "string") main.append(button("View original assertion", () => open(lifecycle.supersedes as string), "knowledge-quiet"));
        if (r.kind === "claim" && (meta?.supersedes || meta?.superseded_by)) {
          const versions = el("section", undefined, "knowledge-versions"); versions.append(el("h3", "Versions")); main.append(versions);
          pending.push((async () => { const seen = new Set<string>(), queue = [r.id]; while (queue.length && seen.size < 10) { const nextId = queue.shift()!; if (seen.has(nextId)) continue; seen.add(nextId); const version = nextId === r.id ? r : (await feature.invoke("record", { id: nextId, includeMetadata: true, maxChars: 4000 })).record; if (!live(n)) return; if (!version) continue; const item = el("div", undefined, "knowledge-version"); item.append(el("code", `rev ${version.revision}`), button(version.body || version.title, () => open(version.id), "knowledge-quiet"), el("small", `${version.lifecycle === "active" ? "Current · saved" : version.lifecycle === "withdrawn" ? "Withdrawn" : "Replaced"} ${version.metadata?.lifecycle_change?.at ? date(version.metadata.lifecycle_change.at) : version.recordedAt ? date(version.recordedAt) : "time not recorded"}`)); if (version.id === r.id) { item.classList.add("knowledge-version-viewing"); item.append(chip("Viewing")); } versions.append(item); for (const linked of [version.metadata?.supersedes, version.metadata?.superseded_by]) if (linked && !seen.has(linked)) queue.push(linked); } if (queue.length) versions.append(el("p", "Showing 10 linked versions. Open a version to continue.")); })().catch(error => { if (live(n)) versions.append(failure(error)); }));
        }
        const body = el("div", undefined, "knowledge-summary"), bodyText = withoutTitleHeading(r.body ?? "", r.title);
        body.append(markdownView(bodyText, targetId => {
          if (targetId !== id) { open(targetId); return; }
          files.open = true;
          const originals = files.querySelector<HTMLDetailsElement>(".knowledge-retained-originals");
          if (originals) { originals.open = true; originals.scrollIntoView({ block: "nearest" }); }
        }, result.links));
        // Long agent-written notes preview behind a disclosure so structured
        // sections (attendance, claims) stay near the top of the page.
        if (bodyText.length > longBodyChars) { const notes = el("details", undefined, "knowledge-notes-toggle"), summary = el("summary"); notes.dataset.readingKey = `notes:${id}`; summary.append(disclosureLabel("Show full notes", "Show less")); notes.append(summary); body.dataset.clamped = "true"; body.append(notes); }
        body.append(el("span", `${r.writtenByAgentId ? `Saved by ${agentName(r.writtenByAgentId)}` : "Author not recorded"} · revision ${r.revision}${meta?.updated_at ? ` · updated ${date(meta.updated_at)}` : ""}`, "knowledge-summary-meta"));
        if (meta?.attribution_confidence) {
          const confidence = meta.attribution_confidence;
          main.append(el("p", `Speaker attribution confidence: ${confidence.level}. ${confidence.basis}`, "knowledge-notice"));
        }
        if (meta?.identity?.candidates?.length) {
          const candidates = el("section"); candidates.append(el("h3", "Possible identity matches"));
          for (const candidate of meta.identity.candidates) {
            const match = result.references?.find(ref => ref.id === candidate.id);
            const card = el("section", undefined, "knowledge-candidate knowledge-surface"); card.append(button(`Possible match: ${match?.title ?? "Candidate identity"}`, () => open(candidate.id), "knowledge-quiet"), el("p", candidate.basis), el("p", `Both records stay separate unless ${agentName() ?? "your agent"} finds evidence they’re the same person.`, "knowledge-muted"), button(`${askLabel()} to check`, () => ask(r, false, { id: candidate.id, title: match?.title ?? candidate.id }), "knowledge-quiet"));
            for (const evidence of candidate.evidence) { const verified = result.identityEvidence?.find(item => item.id === candidate.id)?.evidence.find(e => e.path === evidence.path && e.sha256 === evidence.sha256 && e.start_line === evidence.start_line && e.end_line === evidence.end_line); if (verified) card.append(evidenceView(feature, { ...result, evidence: [verified], evidenceTotal: 1, evidenceSourceTotal: 1, nextEvidenceOffset: null }, () => live(n), errorText)); else card.append(el("p", `Evidence: ${evidence.filename ?? evidence.path}${evidence.start_line ? ` · lines ${evidence.start_line}–${evidence.end_line ?? evidence.start_line}` : ""}. Open the record to inspect this citation.`, "knowledge-muted")); } candidates.append(card);
          }
          main.append(candidates);
        }
        if (r.kind === "page") main.append(body);
        else {
          const statement = el("section", undefined, "knowledge-statement"), surface = el("div", undefined, "knowledge-surface knowledge-claim-groups");
          statement.append(el("h3", r.kind === "claim" ? "Statement & evidence" : "Relationship & evidence"));
          surface.append(renderClaim({ record: r, truncated: result.content.nextOffset !== null, evidenceTotal: result.evidenceTotal, evidenceSourceTotal: result.evidenceSourceTotal }, n, undefined, result));
          statement.append(surface, el("p", `Revision ${r.revision}${meta?.updated_at ? ` · updated ${date(meta.updated_at)}` : ""}`, "knowledge-summary-meta")); main.append(statement);
        }
        if (result.content.nextOffset !== null) main.append(el("p", "Preview is truncated. Open the original Markdown in File details for paged content."));
        const attended = el("section", undefined, "knowledge-attended"), attendanceRows = el("div", undefined, "knowledge-surface"); const attendanceIds = new Set<string>();
        if (r.type === "meeting") { attended.append(el("h3", "Attended"), attendanceRows); main.append(attended); }
        const knownFrom = el("span"); if (r.type === "person") facts.append(knownFrom);
        const owned = el("section"); owned.append(el("h3", `Commitments owned · owner only, not about ${r.title}`));
        const claims = el("section"), connections = el("section"), learned = el("section");
        if (r.kind === "page") { claims.append(el("h3", `What ${agentName() ?? "your agent"} knows`)); main.append(claims, owned); owned.hidden = true; }
        connections.append(el("h3", "Connections")); learned.append(el("h3", "Learned in"), el("p", "Conversation not recorded.", "knowledge-muted")); aside.append(connections, learned);
        const files = el("details", undefined, "knowledge-file-details"); files.dataset.readingKey = `files:${id}`; files.dataset.preserveSignature = `${r.hash}:${r.valid}`; const fileSummary = el("summary", "File details"); fileSummary.append(icon("chevronDown", 12)); files.append(fileSummary);
        const filePanel = el("div", undefined, "knowledge-surface knowledge-file-panel"), fileActions = el("div", undefined, "knowledge-file-actions");
        const dl = el("dl"); for (const [label, value] of [["File", r.path], ["ID", r.id], ["Revision", String(r.revision)]]) dl.append(el("dt", label), el("dd", value));
        const checkpointValue = el("dd", "Checking…"); dl.append(el("dt", "History"), checkpointValue); filePanel.append(dl);
        const technical = el("details", undefined, "knowledge-technical-details"); technical.append(el("summary", "Technical metadata"), el("p", `Lifecycle: ${r.lifecycle}`), el("code", `SHA-256: ${r.hash}`), rawBlock("Structured metadata", JSON.stringify(meta, null, 2)));
        const raw = button("View Markdown", () => {
          raw.disabled = true; let next = 0; const text = el("pre"); const more = button("Read more Markdown", () => { void read(); });
          async function read() { more.disabled = true; try { const page = await feature.invoke("record", { id, view: "raw", offset: next, maxChars: 65536 }); if (disposed || vaultChanged || !filePanel.isConnected || !context.host.connection.connected) return; if (page.record?.hash !== r.hash) throw Error("Record changed; reopen it to read the current Markdown."); text.textContent += page.record.raw ?? ""; if (page.content.nextOffset === null) more.remove(); else { next = page.content.nextOffset; more.disabled = false; } } catch (error) { filePanel.append(failure(error)); more.disabled = false; } }
          filePanel.append(text, more); void read();
        }); raw.prepend(icon("fileText", 14));
        const historyList = el("div", undefined, "knowledge-history-list"); historyList.hidden = true;
        const historyButton = button("History", () => { historyList.hidden = !historyList.hidden; historyButton.setAttribute("aria-expanded", String(!historyList.hidden)); }, "knowledge-quiet"); historyButton.prepend(icon("clock", 14)); historyButton.setAttribute("aria-expanded", "false");
        fileActions.append(raw, historyButton); filePanel.append(fileActions, historyList, technical); files.append(filePanel); aside.append(files);
        if (r.kind === "page" && result.sourceFiles?.length) {
          // One compact row per file. Downloads need the retaining record's
          // authority, so a file retained only by a citing claim downloads there.
          const sourceFile = (file: NonNullable<typeof result.sourceFiles>[number]) => {
            const e = file.evidence, name = e.filename ?? e.path.split("/").at(-1)!, row = el("div", undefined, "knowledge-source-file"), copy = el("span", undefined, "knowledge-source-file-copy");
            const title = el("span", name, "knowledge-source-file-name"); title.title = e.attribution ? `${name}\n${e.attribution}` : name;
            copy.append(title, el("small", [fileKind(e), e.size !== undefined ? fileSize(e.size) : "", file.citations ? `${file.citations} cited ${file.citations === 1 ? "passage" : "passages"}` : ""].filter(Boolean).join(" · ")));
            if (!e.verified) { const warning = el("small", "Source file unavailable", "knowledge-unverified"); warning.prepend(icon("alertTriangle", 12)); copy.append(warning); }
            row.append(icon("fileText", 14), copy);
            const own = result.evidence?.some(o => o.path === e.path && o.sha256 === e.sha256);
            if (own && e.verified) { const { download, status } = originalDownload(feature, id, e, () => live(n), errorText, true); download.className = "knowledge-source-download"; copy.append(status); row.append(download); }
            else if (e.verified) row.title = "Download this file from the claim that cites it.";
            return row;
          };
          // Cited files lead and uncited retained files collapse beneath them.
          // Outside meetings a page's own retained files already live in File
          // details, so the rail appears only when claims sourced here cite files.
          const cited = result.sourceFiles.filter(file => file.citations), uncited = result.sourceFiles.filter(file => !file.citations);
          if (cited.length || r.type === "meeting") {
            const sources = el("section", undefined, "knowledge-sources"), passages = cited.reduce((sum, file) => sum + file.citations, 0), total = result.sourceFilesTotal ?? result.sourceFiles.length;
            sources.append(el("h3", "Sources"), el("p", `${passages} cited ${passages === 1 ? "passage" : "passages"} · ${total} ${total === 1 ? "file" : "files"}`, "knowledge-muted"));
            if (cited.length) { const list = el("div", undefined, "knowledge-surface knowledge-source-files"); list.append(...cited.map(sourceFile)); sources.append(list); }
            if (uncited.length) {
              const rest = el("details", undefined, "knowledge-source-uncited"), summary = el("summary", `${uncited.length} ${cited.length ? "more " : ""}${uncited.length === 1 ? "file" : "files"} not cited directly`), list = el("div", undefined, "knowledge-surface knowledge-source-files");
              rest.dataset.readingKey = `uncited:${id}`; rest.open = !cited.length; summary.append(icon("chevronDown", 12)); list.append(...uncited.map(sourceFile)); rest.append(summary, list); sources.append(rest);
            }
            if (total > result.sourceFiles.length) sources.append(el("p", "Showing the first 100 files. Other files remain available from their citing claims.", "knowledge-muted"));
            aside.insertBefore(sources, learned);
          }
        }
        if (r.kind === "page" && result.evidence?.length) { const originals = el("details", undefined, "knowledge-retained-originals"); originals.append(el("summary", "Retained originals"), evidenceView(feature, result, () => live(n), errorText)); filePanel.append(originals); }
        grid.append(main, aside); target.replaceChildren(breadcrumb, head, grid);
        if (r.kind === "claim" && meta?.entities?.length) {
          const about = el("section", undefined, "knowledge-about"), targets = el("div", undefined, "knowledge-surface knowledge-connections");
          about.append(el("h3", "About"), targets); aside.prepend(about);
          const ids = [...new Set(meta.entities)].slice(0, 20);
          pending.push(Promise.all(ids.map(async entityId => result.references?.find(ref => ref.id === entityId) ?? (await feature.invoke("record", { id: entityId, view: "summary" })).record)).then(records => {
            if (!live(n)) return;
            for (const record of records) if (record) { const row = el("div", undefined, "knowledge-connection"); row.append(summaryLink(record)); targets.append(row); }
            if (!targets.children.length) targets.append(el("p", "Linked records are unavailable.", "knowledge-aside-empty"));
            if (meta.entities!.length > ids.length) about.append(el("p", "Showing the first 20 linked entities.", "knowledge-muted"));
          }).catch(error => { if (live(n)) targets.append(failure(error)); }));
        }
        const refs = el("div", undefined, "knowledge-surface knowledge-connections"); connections.append(refs);
        if (r.kind === "relationship") {
          for (const [role, endpointId] of [["From", meta?.from], ["To", meta?.to]] as const) {
            const row = el("div", undefined, "knowledge-connection"), copy = el("span", undefined, "knowledge-connection-copy");
            copy.append(el("small", role), el("span", endpointId ? "Loading…" : "Page not recorded.")); row.append(copy); refs.append(row);
            if (!endpointId) continue;
            pending.push((async () => {
              const target = result.references?.find(ref => ref.id === endpointId) ?? (await feature.invoke("record", { id: endpointId, view: "summary" })).record;
              if (!live(n)) return;
              copy.replaceChildren(el("small", role), el("span", target?.title ?? "Page unavailable."));
              if (target) {
                const destination = button("", () => open(target.id), "knowledge-connection-link");
                destination.append(tile(target.type, 24, target.kind), copy); row.replaceChildren(destination);
              }
            })().catch(error => { if (live(n)) { copy.replaceChildren(el("small", role), el("span", "Page unavailable.")); row.append(failure(error)); } }));
          }
        }
        const claimSurface = el("div", undefined, "knowledge-surface knowledge-claim-groups"); claims.append(claimSurface);
        const connectionLoading = el("p", "Loading connections…", "knowledge-muted"); refs.append(connectionLoading);
        const claimsLoading = el("p", "Loading saved claims…", "knowledge-muted"); if (r.kind === "page") claimSurface.append(claimsLoading);
        // Claims and rail connections page independently. A single mixed stream
        // let a page of claims crowd out every relationship, so a person with
        // many claims showed no attendance. Dependents are omitted: they repeat
        // the claims list and incoming relationships.
        const railDirections: Array<"outgoing" | "incoming" | "links" | "backlinks"> = r.kind === "page" ? ["outgoing", "incoming", "backlinks"] : ["outgoing", "incoming", "links", "backlinks"];
        let claimOffset: number | null = 0, railIndex = 0, railOffset = 0, snapshot: string | undefined; const claimGroups = new Map<string, HTMLElement>();
        const railMore = () => railIndex < railDirections.length, railIds = new Set<string>();
        const connectionsPage = async (direction: "claims" | typeof railDirections[number], offset: number) => {
          const page = await feature.invoke("connections", { id, direction, offset, limit: 20, includeCards: direction === "claims", includeEndpoints: direction === "incoming" || direction === "outgoing" });
          if (live(n) && snapshot && snapshot !== page.snapshot) throw Error("Connections changed; reopen this page to refresh.");
          snapshot = page.snapshot; return page;
        };
        async function moreClaims() {
          const page = await connectionsPage("claims", claimOffset ?? 0); if (!live(n)) return;
          claimsLoading.remove();
          for (const link of page.connections) {
            const card = claimCard(link.record, n, id);
            // A meeting's own event claim restates the meeting page and its
            // attendance, so it isn't listed here or on attendees' pages.
            if (!card || link.record.sourceEvent || (r.type === "meeting" && link.record.card?.source?.id !== id)) continue; if (card.dataset.kind === "Owned commitments") { owned.hidden = false; owned.append(card); continue; } const kind = card.dataset.kind!; let group = claimGroups.get(kind); if (!group) { group = el("div", undefined, "knowledge-claim-group"); group.append(el("h4", label(kind))); claimGroups.set(kind, group); claimSurface.append(group); } group.append(card); const count = group.querySelectorAll(".knowledge-claim").length; group.querySelector("h4")!.textContent = `${({belief:"Beliefs",commitment:"Commitments",decision:"Decisions",preference:"Preferences",fact:"Facts",event:"Events"} as Record<string,string>)[kind] ?? label(kind)} · ${count}`;
          }
          const count = claims.querySelectorAll(".knowledge-claim").length; claims.querySelector("h3")!.replaceChildren(document.createTextNode(`What ${agentName() ?? "your agent"} knows `), el("span", `${count} ${count === 1 ? "claim" : "claims"}${page.nextOffset !== null ? " shown" : ""}`, "knowledge-section-count"));
          claimOffset = page.nextOffset; moreClaimsButton.remove();
          if (claimOffset !== null) claims.append(moreClaimsButton);
          else if (!claimGroups.size) { claimSurface.remove(); claims.append(el("p", `No claims about ${r.title}.${r.type === "person" && attendanceIds.size ? " Only attendance is recorded." : ""}`)); }
        }
        async function moreConnections() {
          // Fill one page of up to 20 rows, moving through directions in order.
          let shown = 0;
          while (shown < 20 && railMore()) {
            const page = await connectionsPage(railDirections[railIndex], railOffset); if (!live(n)) return;
            const endpoints = page.connections.map(link => { const targetId = link.direction === "incoming" ? link.from : link.direction === "outgoing" ? link.to : undefined; return targetId ? page.endpoints?.find(record => record.id === targetId) ?? null : null; });
            for (const [i, link] of page.connections.entries()) {
              const row = el("div", undefined, "knowledge-connection"), target = endpoints[i] ?? link.record;
              // A wikilink to a record already shown as a typed connection adds nothing.
              if ((link.direction === "links" || link.direction === "backlinks") && (railIds.has(target.id) || attendanceIds.has(target.id))) continue;
              railIds.add(target.id);
              if (link.label === "attended" && ((r.type === "meeting" && link.to === id) || (r.type === "person" && link.from === id))) {
                attendanceIds.add(target.id);
                if (r.type !== "person") { const attendee = el("div", undefined, "knowledge-attendee"); attendee.append(summaryLink(target), el("p", link.record.attributionConfidence?.basis ?? "No attribution basis recorded"), confidenceView(link.record.attributionConfidence, true)); attendanceRows.append(attendee); continue; }
              }
              const destination = button("", () => open(target.id), "knowledge-connection-link"), copy = el("span", undefined, "knowledge-connection-copy");
              copy.append(el("small", `${link.direction === "incoming" ? "← " : ""}${label(link.label ?? link.direction)}`), el("span", target.title));
              destination.append(tile(target.type, 24, target.kind), copy); row.append(destination); if (endpoints[i]) copy.querySelector("small")!.append(confidenceView(link.record.attributionConfidence, true));
              if (endpoints[i]) { const detail = button("", () => open(link.record.id), "knowledge-connection-evidence"); detail.setAttribute("aria-label", "Relationship evidence"); detail.title = "Relationship evidence"; detail.append(icon("paperclip", 13)); row.append(detail); } refs.append(row);
            }
            shown += page.connections.length;
            if (page.nextOffset !== null) railOffset = page.nextOffset; else { railIndex++; railOffset = 0; }
          }
          // Counts say "shown" only while more connections remain unloaded.
          const partial = railMore() ? " shown" : "";
          if (attendanceIds.size && r.type === "person") knownFrom.textContent = `Known from ${attendanceIds.size} meeting${attendanceIds.size === 1 ? "" : "s"}${partial}`;
          if (attendanceIds.size && r.type === "meeting") attended.querySelector("h3")!.textContent = `Attended · ${attendanceIds.size} ${attendanceIds.size === 1 ? "person" : "people"}${partial} · from attendance connections`;
          connectionLoading.remove(); loadMore.remove();
          if (railMore()) connections.append(loadMore);
          else if (!refs.children.length) { refs.remove(); connections.append(el("p", "No connections recorded.", "knowledge-muted")); }
        }
        const pageLoader = (loader: () => Promise<void>, control: () => HTMLButtonElement, section: HTMLElement) => () => { ++connectionPages; control().disabled = true; void loader().catch(error => { section.append(failure(error)); }).finally(() => { control().disabled = false; }); };
        const loadMore = button("More connections", pageLoader(moreConnections, () => loadMore, connections));
        const moreClaimsButton = button("More claims", pageLoader(moreClaims, () => moreClaimsButton, claims), "knowledge-quiet");
        pending.push((async () => {
          for (let page = 0; page < pages; page++) {
            await moreConnections();
            if (!live(n) || !loadMore.parentElement) break;
          }
        })());
        if (r.kind === "page") pending.push((async () => {
          for (let page = 0; page < pages; page++) {
            await moreClaims();
            if (!live(n) || claimOffset === null) break;
          }
        })());
        if (result.references?.length) { const references = el("details"); references.append(el("summary", "Record references · not asserted relationships")); for (const ref of result.references) references.append(summaryLink(ref)); if (result.nextReferenceOffset != null) references.append(el("p", "Showing the first 20 references.")); technical.append(references); }
        pending.push(feature.invoke("history", { id, limit: 10 }).then(history => {
          if (!live(n)) return;
          const checkpoint = history.mutations.find(m => m.hash === r.hash)?.git;
          checkpointValue.textContent = checkpoint ? label(checkpoint.state) : "Not recorded";
          checkpointValue.title = checkpoint?.message ?? "No Git checkpoint recorded for this revision.";
          for (const entry of history.entries) historyList.append(el("p", `Revision ${entry.revision} · ${date(entry.at)} · ${human(entry.provenance)}`));
          if (!history.entries.length) historyList.append(el("p", "No saved history recorded."));
          if (history.nextOffset !== null) historyList.append(el("p", "Showing the latest 10 revisions."));
        }).catch(error => { if (live(n)) { checkpointValue.textContent = "Unavailable"; historyList.append(failure(error)); } }));
        // Commit the primary content now. Secondary panels retain this view's
        // generation fence, so delayed responses cannot replace a newer page.
        const panels = Promise.all(pending).catch(error => { if (live(n)) { connectionLoading.remove(); claimsLoading.remove(); connections.append(failure(error)); } });
        // Background replacement needs the complete tree to preserve existing
        // expanded evidence, focus and scroll state. Only navigation streams it.
        if (waitForPanels) await panels;
      }
      async function browse(n: number, target: HTMLElement) {
        const result = await feature.invoke("records", { kind, offset, limit: 50, includeCards: kind === "claim", includeEndpoints: kind === "relationship", ...(type ? { type } : {}), ...(browseQuery ? { query: browseQuery } : {}), ...(includeHistory ? { lifecycle: "all" } : {}), ...(originFilter && kind === "claim" ? { assertionOrigin: originFilter } : {}) });
        if (!live(n) || n !== generation) return;
        const layout = el("div", undefined, "knowledge-browse"), facets = el("nav", undefined, "knowledge-facets"); facets.setAttribute("aria-label", "Types");
        const facet = (name: string, label: string, count?: number) => { const control = button(label, () => { type = name; offset = 0; void load(); }, "knowledge-facet"); control.prepend(name ? tile(name, 20) : el("span", undefined, "knowledge-facet-spacer")); control.setAttribute("aria-pressed", String(type === name)); if (count !== undefined) control.append(el("span", count.toLocaleString(), "knowledge-facet-count")); facets.append(control); };
        facet("", kind === "claim" ? "All claims" : "Everything", kind === "page" && vocabulary ? vocabulary.definitions.reduce((sum, d) => sum + d.recordCount, 0) : !type ? result.total : undefined);
        if (kind === "page" && vocabulary) { let group = ""; for (const def of [...vocabulary.definitions].filter(d => d.recordCount > 0).sort((a, b) => ["entity", "concept", "media", "temporal", "annotation"].indexOf(a.primitive) - ["entity", "concept", "media", "temporal", "annotation"].indexOf(b.primitive))) { if (group !== def.primitive) { group = def.primitive; facets.append(el("h3", ({entity:"People & things",concept:"Ideas & projects",media:"Sources & writing",temporal:"Events & conversations",annotation:"Annotations"} as Record<string,string>)[group] ?? human(group), "knowledge-eyebrow")); } facet(def.name, ({Person:"People",Company:"Companies",Project:"Projects",Concept:"Concepts",Meeting:"Meetings",Note:"Notes",Source:"Sources"} as Record<string,string>)[def.label] ?? def.label, def.recordCount); } facets.append(el("p", `${vocabulary.definitions.filter(d => !d.recordCount).length} empty types hidden`, "knowledge-muted")); }
        if (kind === "claim" && result.facets) { facets.prepend(el("h3", "Claim kinds", "knowledge-eyebrow")); for (const [name, count] of Object.entries(result.facets.kinds)) if (count > 0) facet(name, label(name), count); const origins = Object.entries(result.facets.origins); facets.append(el("p", `${origins.length === 1 && origins[0][0] === "source" ? `All ${origins[0][1]} claims are from sources.` : origins.map(([name, count]) => `${count} ${origin(name)}`).join(" · ")} Kinds with no claims are hidden.`, "knowledge-muted")); }
        const panel = el("div", undefined, "knowledge-surface knowledge-table-wrap"), controls = el("div", undefined, "knowledge-table-toolbar");
        const filter = el("form", undefined, "knowledge-browse-filter"), input = el("input"); input.type = "search"; input.placeholder = kind === "claim" ? "Filter claim text" : "Filter by name or alias"; input.setAttribute("aria-label", input.placeholder); input.value = browseQuery; filter.append(input); filter.onsubmit = event => { event.preventDefault(); browseQuery = input.value.trim(); offset = 0; void load(); }; input.onchange = () => { browseQuery = input.value.trim(); offset = 0; void load(); }; controls.append(filter);
        const kinds = el("div", undefined, "knowledge-kind-switch"); kinds.setAttribute("role", "group"); kinds.setAttribute("aria-label", "Record kind");
        for (const [value, label] of [["page", "Pages"], ["claim", "Claims"], ["relationship", "Connections"]] as const) { const b = button(label, () => { kind = value; type = ""; offset = 0; void load(); }, "knowledge-quiet"); b.setAttribute("aria-pressed", String(kind === value)); kinds.append(b); }
        controls.append(kinds);
        const history = el("div", undefined, "knowledge-kind-switch"); for (const [all, name] of [[false, "Current"], [true, "Include history"]] as const) { const b = button(name, () => { includeHistory = all; offset = 0; void load(); }, "knowledge-quiet"); b.setAttribute("aria-pressed", String(includeHistory === all)); history.append(b); } controls.append(history);
        if (kind === "claim" && result.facets && Object.keys(result.facets.origins).length > 1) { const select = el("select"); select.setAttribute("aria-label", "Assertion origin"); for (const value of ["", ...Object.keys(result.facets.origins)]) { const option = el("option", value ? origin(value) : "All origins"); option.value = value; select.append(option); } select.value = originFilter; select.onchange = () => { originFilter = select.value; offset = 0; void load(); }; controls.append(select); }
        panel.append(controls);
        if (kind === "claim") { for (const record of result.records) { if (record.lifecycle !== "active") { const row = el("div", undefined, "knowledge-historical knowledge-connection"); row.append(summaryLink(record), el("small", `${record.lifecycle === "withdrawn" ? "Withdrawn" : "Replaced"} · ${record.updatedAt ? date(record.updatedAt) : "Time not recorded"}`)); panel.append(row); } else { const card = claimCard(record, n); if (card) panel.append(card); } } }
        else if (kind === "relationship") {
          const endpoints = new Map((result.endpoints ?? []).map(record => [record.id, record]));
          for (const record of result.records) {
            const row = el("div", undefined, "knowledge-connection knowledge-browse-connection");
            for (const [i, id] of [record.from, record.to].entries()) { if (i) row.append(el("span", label(record.label ?? record.type))); const endpoint = id ? endpoints.get(id) : undefined; row.append(endpoint ? summaryLink(endpoint) : el("span", "Page unavailable")); }
            row.append(record.lifecycle === "active" ? confidenceView(record.attributionConfidence, true) : button(`Withdrawn · ${record.updatedAt ? date(record.updatedAt) : "Time not recorded"}`, () => open(record.id), "knowledge-quiet")); panel.append(row);
          }
        }
        else { const table = el("table", undefined, "data-table knowledge-table"), head = el("thead"), row = el("tr"); for (const label of ["Name", "Type", "Occurred", "Last updated"]) { const th = el("th", label); if (label === "Last updated") { th.setAttribute("aria-sort", "descending"); th.append(el("span", " ↓", "knowledge-sort-indicator")); } row.append(th); } head.append(row); table.append(head); const body = el("tbody"); for (const record of result.records) { const row = el("tr"), name = el("td"); name.append(summaryLink(record)); row.append(name, el("td", label(record.type)), el("td", record.occurredAt ? `${formatSourceDate(record.occurredAt)}${/^\d{4}-\d{2}-\d{2}$/.test(record.occurredAt) ? " · date only" : ""}` : "—"), el("td", record.updatedAt ? date(record.updatedAt) : "Not recorded")); body.append(row); } table.append(body); panel.append(table); }
        if (!result.records.length) panel.append(empty("Nothing here yet", "Tell your agent in chat and saved knowledge will appear here."));
        const pages = el("div", undefined, "knowledge-pagination");
        const capped = result.nextOffset !== null && result.nextOffset > 500;
        pages.append(el("span", `${result.total ? offset + 1 : 0}–${offset + result.records.length} of ${result.total.toLocaleString()} · ${result.total > 550 ? "partial browse access" : `complete list${includeHistory ? " · including history" : ""}`}`));
        const previous = button("Previous", () => { offset = Math.max(0, offset - 50); void load(); }); previous.disabled = !offset;
        const next = button("Next", () => { offset = result.nextOffset!; void load(); }); next.disabled = result.nextOffset === null || capped; pages.append(previous, next); panel.append(pages);
        if (capped) panel.append(el("p", "This server cannot page beyond 550 records. Narrow the type filter to see more.", "knowledge-notice"));
        const results = el("div", undefined, "knowledge-browse-results"); results.append(panel); layout.append(facets, results); target.replaceChildren(layout);
      }
      async function recent(n: number, target: HTMLElement) {
        const activity = await feature.invoke("recent", { limit: 20, groupBySource: true, includeEndpoints: true, ...recentCursor }); if (!live(n)) return;
        if (!recentCursor) recentSequence = activity.upperSequence;
        const feed = el("div", undefined, "knowledge-feed");
        let currentDay = "", group: HTMLElement | undefined, lifecycleGroup: HTMLElement | undefined; let firstSource = true;
        // Each day orders its cards: corrections, source groups, then saves
        // with no source page ("Edited outside OpenClaw", "Saved in conversation").
        let sourceGroups: HTMLElement | undefined; const looseGroups = new Map<string, HTMLElement>();
        const looseGroup = (heading: string) => { let section = looseGroups.get(heading); if (!section) { section = el("section", undefined, "knowledge-loose-group"); section.append(el("h3", heading, "knowledge-group-heading")); looseGroups.set(heading, section); group!.append(section); } return section; };
        // A loose save of a page that also heads a source group on this page is
        // shown as that group's source row instead of a second row.
        const sourceMarkers = new Map<string, (status: string) => void>(), looseSaves: Array<{ id: string; row: HTMLElement; status: string }> = [];
        for (const entry of activity.items) {
          const day = new Date(entry.at).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
          if (day !== currentDay) {
            currentDay = day;
            const zone = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(new Date(entry.at)).find(p => p.type === "timeZoneName")?.value ?? "local time";
            feed.append(el("h2", `${new Date(entry.at).toDateString() === new Date().toDateString() ? `Today · ${day}` : day} · saved times in ${zone}`, "knowledge-eyebrow")); lifecycleGroup = undefined;
            group = el("section", undefined, "knowledge-day"); feed.append(group); sourceGroups = el("div", undefined, "knowledge-source-groups"); group.append(sourceGroups); looseGroups.clear();
          }
          const lifecycle = entry.change === "corrected" || entry.change === "withdrawn";
          const row = el("article", undefined, "knowledge-feed-item"); row.dataset.change = entry.change; row.dataset.readingKey = `activity:${entry.sequence}`;
          const copy = el("span", undefined, "knowledge-feed-copy");
          const kindLabel = entry.kind === "relationship" ? "Connection" : label(entry.type);
          const savedTime = time(entry.at);
          const badgeLabel = ({created:"New", updated:"Updated", observed:"Observed in vault", external:"Edited outside OpenClaw", corrected:"Corrected", withdrawn:"Withdrawn"})[entry.change];
          copy.append(el("span", entry.title || `${kindLabel} ${entry.change}`, "knowledge-feed-title"), identityTag(entry.identityStatus));
          const description = entry.change === "corrected" ? `${kindLabel} · Corrected` : entry.change === "withdrawn" ? `${kindLabel} · Withdrawn` : entry.change === "external" ? `${kindLabel} · Edited outside OpenClaw` : kindLabel;
          copy.append(el("span", `${description} · Saved ${savedTime}`, "knowledge-feed-meta"));
          if (entry.group) {
            row.classList.add("knowledge-source-activity");
            const source = entry.group.source, key = `source:${source.id}`;
            const disclosure = el("details", undefined, "knowledge-activity-details"); disclosure.dataset.readingKey = key; disclosure.open = recentExpanded.has(key) || (firstSource && !recentCursor && !recentExpanded.size); firstSource = false;
            disclosure.ontoggle = () => { if (disclosure.isConnected) { if (disclosure.open) recentExpanded.add(key); else recentExpanded.delete(key); } };
            const summary = el("summary", undefined, "knowledge-activity-summary"), text = el("span", undefined, "knowledge-feed-copy");
            text.append(el("span", source.title, "knowledge-feed-title"));
            const metadata = el("span", undefined, "knowledge-source-meta");
            if (source.occurredAt) { const occurred = el("span"); occurred.append(icon("calendarClock", 12), el("span", `Occurred ${formatSourceDate(source.occurredAt)}`)); metadata.append(occurred); }
            metadata.append(el("span", `Saved ${entry.group.firstSaved && entry.group.lastSaved && time(entry.group.firstSaved) !== time(entry.group.lastSaved) ? `${time(entry.group.firstSaved)}–${time(entry.group.lastSaved)}` : savedTime} · ${entry.group.total} ${entry.group.total === 1 ? "record" : "records"}`));
            text.append(metadata);
            const names: Record<string, string> = { attendees: "attended", decision: "decisions", commitment: "commitments", event: "events", belief: "beliefs", fact: "facts", preference: "preferences", page: "pages" };
            text.append(el("span", Object.keys(names).filter(kind => entry.group!.counts[kind]).map(kind => `${entry.group!.counts[kind]} ${entry.group!.counts[kind] === 1 && kind !== "attendees" ? names[kind].replace(/s$/, "") : names[kind]}`).concat(entry.group.counts.sourceEvent ? ["meeting event"] : []).join(" · "), "knowledge-feed-meta"));
            summary.append(tile(source.type, 32), text, disclosureLabel("Expand", "Collapse"));
            const detail = el("div", undefined, "knowledge-source-body");
            const pages = el("div", undefined, "knowledge-source-pages"), claims = el("div", undefined, "knowledge-source-claims"); detail.append(pages, claims);
            const saveRow = (record: Pick<Summary, "id" | "title" | "type" | "kind" | "identityStatus" | "occurredAt">, status?: string) => {
              const row = button("", () => open(record.id), "knowledge-source-record"), copy = el("span", undefined, "knowledge-feed-copy"), title = el("span", undefined, "knowledge-source-title"), meta = el("span", undefined, "knowledge-source-meta");
              title.append(el("span", record.title, "knowledge-feed-title"), identityTag(record.identityStatus));
              if (status) { const change = el("span", undefined, "knowledge-save-status"); change.dataset.change = status; change.append(icon(status === "New" ? "plus" : status === "Updated" ? "pencil" : "eye", 12), el("span", status)); meta.append(change); }
              meta.append(el("span", label(record.type)));
              if (record.occurredAt) { const occurred = el("span"); occurred.append(icon("calendarClock", 12), el("span", `${formatSourceDate(record.occurredAt)}${/^\d{4}-\d{2}-\d{2}$/.test(record.occurredAt) ? " · date only" : ""}`)); meta.append(occurred); }
              copy.append(title, meta); row.append(tile(record.type, 28, record.kind), copy, icon("chevronRight", 14)); return row;
            };
            // Keep the source reachable even when its save is outside this activity page.
            let sourceRow = saveRow(source); pages.append(sourceRow); let sourceMarked = false;
            sourceMarkers.set(source.id, status => { if (sourceMarked) return; const marked = saveRow(source, status); sourceRow.replaceWith(marked); sourceRow = marked; sourceMarked = true; });
            const attendance = el("details", undefined, "knowledge-attendance-group"); attendance.dataset.readingKey = `${key}:attendance`;
            const attendanceSummary = el("summary"), attendanceCopy = el("span", undefined, "knowledge-feed-copy"), attendanceTitle = el("span", `${entry.group.counts.attendees ?? 0} attended`, "knowledge-feed-title"), attendanceRows = el("div", undefined, "knowledge-attendance-rows knowledge-surface");
            attendanceCopy.append(attendanceTitle, el("span", `${entry.group.counts.attendees ?? 0} attendance connections · each with its own attribution`, "knowledge-feed-meta"));
            attendanceSummary.append(tile("attended", 28, "relationship"), attendanceCopy, disclosureLabel("Show all", "Hide")); attendance.append(attendanceSummary, attendanceRows);
            const namesSeen: string[] = []; let attendanceShown = false;
            const appendRecords = (records: typeof entry.group.records, endpoints = entry.group!.endpoints ?? []) => {
              for (const record of [...records].sort((a, b) => ["page", "relationship", "claim"].indexOf(a.kind) - ["page", "relationship", "claim"].indexOf(b.kind))) {
                if (record.sourceEvent) continue;
                if (record.kind === "relationship" && record.label === "attended" && record.to === source.id) {
                  if (!attendanceShown) { detail.insertBefore(attendance, claims); attendanceShown = true; }
                  const person = endpoints.find(person => person.id === record.from);
                  if (!live(n)) return;
                  const row = el("div", undefined, "knowledge-attendee"); if (person) { row.append(summaryLink(person)); namesSeen.push(person.title); } else row.append(el("span", "Person unavailable"));
                  row.append(el("p", record.attributionConfidence?.basis ?? "No attribution basis recorded"), confidenceView(record.attributionConfidence, true)); attendanceRows.append(row);
                  attendanceTitle.textContent = `${namesSeen.slice(0, 3).join(", ")}${(entry.group!.counts.attendees ?? 0) > namesSeen.slice(0, 3).length ? ` and ${entry.group!.counts.attendees - namesSeen.slice(0, 3).length} more` : ""} attended`;
                } else if (record.kind === "claim") { const card = claimCard(record, n); if (card) claims.append(card); }
                else { const row = saveRow(record, record.change === "created" ? "New" : record.change === "updated" ? "Updated" : "Observed in vault"); if (record.id === source.id) { sourceRow.replaceWith(row); sourceRow = row; sourceMarked = true; } else pages.append(row); }
              }
            };
            appendRecords(entry.group.records);
            let recordOffset = entry.group.nextRecordOffset;
            if (recordOffset != null) { const more = button(`Load ${entry.group.total - recordOffset} more from this source`, () => { more.disabled = true; void (async () => { const page = await feature.invoke("recent", { groupBySource: true, includeEndpoints: true, sourceId: source.id, recordOffset: recordOffset!, upperSequence: activity.upperSequence }); if (!live(n)) return; const next = page.items.find(item => item.group?.source.id === source.id)?.group; if (!next) throw Error("Source changed; reopen Recent to refresh."); appendRecords(next.records, next.endpoints); recordOffset = next.nextRecordOffset; if (recordOffset == null) more.remove(); else { more.textContent = `Load ${next.total - recordOffset} more from this source`; detail.append(more); } })().catch(error => detail.append(failure(error))).finally(() => { more.disabled = false; }); }, "knowledge-quiet"); detail.append(more); }
            disclosure.append(summary, detail); row.append(disclosure);
          } else if (lifecycle) {
            row.classList.add("knowledge-activity-event");
            const disclosure = el("details", undefined, "knowledge-activity-details"), summary = el("summary", undefined, "knowledge-activity-summary");
            disclosure.open = recentExpanded.has(entry.sequence);
            disclosure.ontoggle = () => { if (disclosure.isConnected) { if (disclosure.open) recentExpanded.add(entry.sequence); else recentExpanded.delete(entry.sequence); } };
            const meta = copy.querySelector(".knowledge-feed-meta")!, state = el("span", badgeLabel, "knowledge-lifecycle-state"); state.dataset.change = entry.change; state.prepend(icon(entry.change === "corrected" ? "repeat" : "archive", 12));
            meta.classList.add("knowledge-source-meta"); meta.replaceChildren(state, el("span", kindLabel), el("span", savedTime));
            const lifecycleIcon = icon(entry.change === "corrected" ? "repeat" : "archive", 20); lifecycleIcon.dataset.change = entry.change;
            summary.append(lifecycleIcon, copy, icon("chevronDown", 14));
            const detail = el("div", undefined, "knowledge-activity-body");
            const explanation = entry.change === "withdrawn"
              ? "It no longer appears in connections, search or answers. The original and its evidence are kept in history."
              : entry.replacementActive
                ? "This replaced an earlier version. Search and answers now use the current version."
                : "A corrected version was saved, but it is no longer current either. Both versions are kept in history.";
            detail.append(el("p", explanation, "knowledge-activity-reason"));
            const links = el("div", undefined, "knowledge-activity-links");
            if (entry.replacementId) links.append(button(entry.replacementActive ? "Current version" : "View replacement history", () => open(entry.replacementId!)));
            links.append(button("View in history", () => open(entry.id), "knowledge-quiet"));
            detail.append(links); disclosure.append(summary, detail); row.append(disclosure);
            if (entry.reason) {
              const reason = el("details", undefined, "knowledge-activity-audit");
              reason.append(el("summary", "Recorded reason"), el("p", entry.reason, "knowledge-activity-reason"));
              detail.append(reason);
            }
          } else {
            const item = button("", () => open(entry.id), "knowledge-feed-link");
            const meta = copy.querySelector(".knowledge-feed-meta")!, change = el("span", undefined, "knowledge-save-status");
            change.dataset.change = badgeLabel; change.append(icon(entry.change === "created" ? "plus" : entry.change === "updated" || entry.change === "external" ? "pencil" : "eye", 12), el("span", badgeLabel));
            meta.classList.add("knowledge-source-meta"); meta.replaceChildren(change, el("span", `${kindLabel} · Saved ${savedTime}`));
            item.append(tile(entry.type, 28, entry.kind), copy, icon("chevronRight", 14)); row.append(item);
          }
          if (lifecycle) { if (!lifecycleGroup) { lifecycleGroup = el("section", undefined, "knowledge-lifecycle-group"); lifecycleGroup.append(el("h3", "Corrections & withdrawals", "knowledge-group-heading")); group!.prepend(lifecycleGroup); } lifecycleGroup.append(row); lifecycleGroup.querySelector("h3")!.textContent = `Corrections & withdrawals · ${lifecycleGroup.querySelectorAll("article").length}`; }
          else if (entry.group) sourceGroups!.append(row);
          else { looseGroup(entry.change === "external" ? "Edited outside OpenClaw" : "Saved in conversation").append(row); looseSaves.push({ id: entry.id, row, status: badgeLabel }); }
        }
        for (const save of looseSaves) { const mark = sourceMarkers.get(save.id); if (!mark) continue; mark(save.status); const section = save.row.parentElement; save.row.remove(); if (section && !section.querySelector("article")) section.remove(); }
        if (!activity.items.length) feed.append(empty("No recent activity", "Knowledge saved by your agent will appear here. Earlier revisions remain in each record’s history."));
        const pages = el("div", undefined, "knowledge-pagination");
        if (recentBack.length) pages.append(button("Newer activity", () => { recentCursor = recentBack.pop(); void load(); }));
        if (activity.nextBefore !== null) pages.append(button("Load older activity", () => { recentBack.push(recentCursor); recentCursor = { upperSequence: activity.upperSequence, beforeSequence: activity.nextBefore! }; void load(); }));
        feed.append(pages); target.replaceChildren(feed);
      }
      async function load(background = false): Promise<boolean> {
        if (vaultChanged || disposed) return false;
        const n = ++generation, nextView = viewKey(), nextScreen = JSON.stringify([tab, selectedId]);
        if (!context.host.connection.connected) { void refresh(); return false; }
        if (!background) connectionPages = 1;
        // Build off-screen for navigation too. Keep the readable view and its
        // controls mounted until the newest request is ready to commit.
        const target = el("div"); staging = target; loadingGeneration = n;
        if (!background) {
          loading.textContent = selectedId ? "Opening record…" : tab === "browse" ? `Loading ${kind === "relationship" ? "connections" : kind === "claim" ? "claims" : "pages"}…` : `Loading ${tab}…`;
          loading.hidden = false; content.setAttribute("aria-busy", "true");
        }
        try {
          await (async () => {
          if (selectedId) return await showDetail(selectedId, n, target, connectionPages, background);
          if (tab === "recent") return await recent(n, target);
          if (tab === "browse") return await browse(n, target);
          if (tab === "ontology") { const result = await loadVocabulary(feature, true); if (live(n)) target.replaceChildren(button("← Knowledge", () => navigate("recent"), "knowledge-quiet"), button("Vault status", () => navigate("diagnostics"), "knowledge-quiet"), ontologyView(result, open, () => navigate("diagnostics"))); return; }
          if (tab === "diagnostics") { const result = await feature.invoke("diagnostics", {}); if (!live(n)) return; const panel = empty("Vault status", `${result.total} validation findings. Knowledge changes happen through your agent in chat.`); for (const issue of result.issues) panel.append(el("p", `${human(issue.code)} · ${issue.path}: ${issue.message}`)); target.replaceChildren(panel); return; }
          if (!query.trim()) { target.replaceChildren(empty("Search knowledge", "Enter a name or a few words to search all saved text.")); return; }
          const result = await feature.invoke("grep", { query: query.trim(), limit: 20, offset }); if (!live(n)) return;
          if (result.index.state !== "ready") { target.replaceChildren(empty("Search unavailable", result.index.message)); return; }
          if (offset && searchSnapshot && searchSnapshot !== result.index.snapshot) { offset = 0; searchSnapshot = undefined; target.replaceChildren(empty("Knowledge changed", "Run the search again to restart from the current snapshot.")); return; }
          searchSnapshot = result.index.snapshot;
          const list = el("div", undefined, "knowledge-surface"); list.append(el("p", `${result.total} matches · Ranked text search, not a complete inventory`, "knowledge-list-note"));
          if (!result.coverage.complete) list.append(el("p", result.coverage.message, "knowledge-notice"));
          for (const hit of result.hits) { const row = el("article", undefined, "knowledge-search-hit"); row.append(summaryLink(hit.record), el("p", hit.snippet.text), el("small", `Revision ${hit.citation.revision} · ${hit.citation.path}`)); list.append(row); }
          if (!result.total) list.append(empty("No matches", "Try another name or phrase, or browse by type."));
          const pages = el("div", undefined, "knowledge-pagination"); if (offset) pages.append(button("Previous", () => { offset = Math.max(0, offset - 20); void load(); })); if (result.nextOffset !== null) { const next = button("Next", () => { offset = result.nextOffset!; void load(); }); next.disabled = result.nextOffset > 500; pages.append(next); if (next.disabled) list.append(el("p", "This server cannot page beyond 520 search results. Refine your query to see more.", "knowledge-notice")); } list.append(pages); target.replaceChildren(list);
          })();
          if (!live(n) || n !== generation) return false;
          if (background) {
            // Read state after the requests: interactions while checking still win.
            let reading = captureReadingState(content);
            const retained = new Map([...content.querySelectorAll<HTMLElement>("[data-preserve-signature]")].map(node => [node.dataset.readingKey, node]));
            const reusable = (node: HTMLElement) => { const old = retained.get(node.dataset.readingKey); return old?.dataset.preserveSignature === node.dataset.preserveSignature ? old : undefined; };
            await Promise.all([...target.querySelectorAll<HTMLDetailsElement>(".knowledge-claim > details")]
              .filter(node => reading.expanded(node) && !reusable(node.parentElement!)).map(node => evidenceLoaders.get(node)?.()));
            if (!live(n) || n !== generation) return false;
            reading = captureReadingState(content);
            for (const node of target.querySelectorAll<HTMLElement>("[data-preserve-signature]")) { const old = reusable(node); if (old) node.replaceWith(old); }
            content.replaceChildren(...target.childNodes);
            reading.restore(content);
          }
          else {
            const reading = captureReadingState(content);
            content.replaceChildren(...target.childNodes);
            // Preserve list-option focus, but never carry a collapsed preview
            // into a standalone detail where evidence is open by default.
            if (displayScreen === nextScreen) reading.restore(content);
          }
          displayGeneration = n; displayView = nextView; displayScreen = nextScreen; viewReady = true;
          return true;
        } catch (error) {
          if (live(n) && n === generation) {
            if (background) { status.textContent = "Refresh unavailable"; status.hidden = false; }
            else { loading.replaceChildren(failure(error), button("Retry", () => { void load(); }, "knowledge-quiet")); loading.hidden = false; }
          }
          return false;
        } finally {
          if (staging === target) staging = undefined;
          if (loadingGeneration === n) { loadingGeneration = 0; content.removeAttribute("aria-busy"); if (!loading.querySelector(".knowledge-error")) loading.hidden = true; }
        }
      }
      let refreshing = false, refreshAgain = false;
      async function refresh() {
        if (vaultChanged || disposed) return;
        if (!context.host.connection.connected) { ++statusGeneration; status.textContent = viewReady ? "Reconnecting…" : "Offline"; status.hidden = false; banner.hidden = false; banner.textContent = `Can’t reach the vault. ${viewReady ? `Showing the last readable view, checked at ${lastChecked ? time(lastChecked) : "an unknown time"}. Retrying.` : "Reconnect to read your agent’s knowledge."}`; return; }
        if (refreshing) { refreshAgain = true; return; }
        refreshing = true;
        const n = ++statusGeneration, observedGeneration = generation;
        try {
          const report = await feature.invoke("status", {}); if (disposed || n !== statusGeneration || !context.host.connection.connected) return;
          const nextIdentity = JSON.stringify([report.agent, report.vault, report.scope]);
          if (identity && identity !== nextIdentity) { vaultChanged = true; ++generation; ++suggestGeneration; toolbar.replaceChildren(); root.querySelector(".knowledge-chat-handoff")?.remove(); status.textContent = "Vault changed"; status.hidden = false; content.replaceChildren(empty("Vault changed", "Reload this page to open the newly connected vault.")); return; }
          identity = nextIdentity; agentId = report.sample ? "" : report.agent; renderAgentCopy();
          lastChecked = new Date().toISOString();
          status.textContent = ""; status.hidden = true;
          sampleChip.hidden = !report.sample; banner.hidden = true; banner.textContent = "";
          if (loadingGeneration || (viewReady && displayView === viewKey() && report.snapshot && snapshot === report.snapshot)) return;
          vocabulary = await loadVocabulary(feature); if (disposed || n !== statusGeneration) return;
          const pageCount = vocabulary.definitions.reduce((sum, d) => sum + d.recordCount, 0);
          const countBadge = el("span", pageCount.toLocaleString(), "knowledge-tab-count"); countBadge.setAttribute("aria-hidden", "true"); browseTab.replaceChildren(document.createTextNode("Browse"), countBadge);
          // A navigation started during the check owns the screen now.
          if (generation !== observedGeneration || loadingGeneration) return;
          if (viewReady && displayView === viewKey() && tab === "recent" && !selectedId && !recentCursor) {
            const recent = await feature.invoke("recent", { limit: 50, groupBySource: true }); if (disposed || n !== statusGeneration || generation !== observedGeneration) return;
            const count = recent.items.filter(item => item.sequence > recentSequence).length;
            pendingSnapshot = report.snapshot; updates.textContent = count ? `↑ ${count}${recent.nextBefore !== null ? "+" : ""} activity ${count === 1 ? "update" : "updates"} · Show` : "Knowledge changed · Show"; updates.hidden = false; return;
          }
          if (await load(viewReady && displayView === viewKey())) snapshot = report.snapshot;
        } catch (error) { if (!disposed && n === statusGeneration) { status.textContent = "Refresh unavailable"; status.hidden = false; if (!viewReady) content.replaceChildren(failure(error)); } }
        finally { refreshing = false; if (refreshAgain) { refreshAgain = false; void refresh(); } }
      }
      let connected = context.host.connection.connected;
      const rosterKey = () => JSON.stringify(context.host.agents.rows.map(agent => [agent.id, agent.name, agent.identity?.name]));
      let names = rosterKey();
      const unsubscribe = context.host.subscribe(() => {
        const nextNames = rosterKey(), namesChanged = names !== nextNames; names = nextNames; if (namesChanged) renderAgentCopy();
        if (namesChanged && viewReady && connected && !vaultChanged) { root.querySelector(".knowledge-chat-handoff")?.remove(); void load(true); }
        if (connected !== context.host.connection.connected) { connected = context.host.connection.connected; ++suggestGeneration; toolbar.querySelector(".knowledge-suggestions")?.replaceChildren(); void refresh(); }
      });
      const unwatch = feature.on("changed", () => void refresh());
      const resync = setInterval(() => { if (context.host.connection.connected && !document.hidden) void refresh(); }, 30000);
      const focusSearch = (event: KeyboardEvent) => { if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || (event.target instanceof HTMLElement && event.target.isContentEditable)) return; const input = root.querySelector<HTMLInputElement>("input[type=search]"); if (input) { event.preventDefault(); input.focus(); } };
      document.addEventListener("keydown", focusSearch);
      renderToolbar(); renderAgentCopy(); void refresh();
      return { dispose() { document.removeEventListener("keydown", focusSearch); disposed = true; ++generation; ++statusGeneration; ++suggestGeneration; clearTimeout(timer); clearInterval(resync); unwatch(); unsubscribe(); root.remove(); } };
    } });
    return () => { removePage(); removeNavigation(); };
  },
});
