import type { FeatureClient } from "openclaw/plugin-sdk/feature-contract";
import type { contract } from "./contract.js";
import type { LookupOutput, SearchOutput } from "./retrieval-contract.js";

type Mode = "all" | "any" | "phrase" | "exact";
export type SearchState = { query: string; mode: Mode; kind: string; type: string; tag: string; lifecycle: "active" | "superseded" | "all"; offset: number; snapshot?: string | null };
export const initialSearchState = (): SearchState => ({ query: "", mode: "all", kind: "", type: "", tag: "", lifecycle: "active", offset: 0 });
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
function button(label: string, run: () => void) { const b = el("button", label); b.type = "button"; b.onclick = run; return b; }
export function searchToolbar(state: SearchState, load: () => void, changed: () => void = () => {}) {
  const form = el("form", undefined, "knowledge-search-form");
  const input = el("input"); input.type = "search"; input.value = state.query; input.maxLength = 500; input.placeholder = "Search titles, aliases and authored text"; input.setAttribute("aria-label", "Knowledge search query");
  const reset = () => { state.offset = 0; state.snapshot = undefined; changed(); };
  input.oninput = () => { state.query = input.value; reset(); };
  form.append(input);
  function select<K extends "mode" | "kind" | "lifecycle">(key: K, label: string, options: [SearchState[K], string][]) {
    const wrapper = el("label", label), node = el("select"); node.setAttribute("aria-label", label);
    for (const [value, text] of options) { const option = el("option", text); option.value = value; node.append(option); }
    node.value = state[key]; node.onchange = () => { state[key] = node.value as SearchState[K]; reset(); }; wrapper.append(node); form.append(wrapper);
  }
  select("mode", "Match", [["all", "All words"], ["any", "Any word"], ["phrase", "Phrase"], ["exact", "Exact ID, name or alias"]]);
  select("kind", "Kind", [["", "All kinds"], ["page", "Pages"], ["claim", "Claims"], ["relationship", "Relationships"]]);
  select("lifecycle", "Lifecycle", [["active", "Active"], ["superseded", "Superseded"], ["all", "Active and superseded"]]);
  for (const [key, placeholder] of [["type", "Type or ontology alias"], ["tag", "Exact tag"]] as const) {
    const field = el("input"); field.value = state[key]; field.placeholder = placeholder; field.maxLength = key === "type" ? 64 : 200; field.setAttribute("aria-label", placeholder);
    field.oninput = () => { state[key] = field.value.trim(); reset(); }; form.append(field);
  }
  const submit = el("button", "Search"); submit.type = "submit"; form.append(submit);
  form.onsubmit = event => { event.preventDefault(); reset(); load(); };
  return form;
}
export async function loadSearch(feature: FeatureClient<typeof contract>, state: SearchState): Promise<SearchOutput | LookupOutput> {
  const input = { query: state.query, lifecycle: state.lifecycle, offset: state.offset, limit: 20,
    ...(state.kind ? { kind: state.kind as "page" | "claim" | "relationship" } : {}), ...(state.type ? { type: state.type } : {}), ...(state.tag ? { tag: state.tag } : {}) };
  return state.mode === "exact" ? feature.invoke("lookup", input) : feature.invoke("grep", { ...input, mode: state.mode });
}
export function searchResults(result: SearchOutput | LookupOutput, state: SearchState, open: (id: string, target: HTMLElement) => void, load: () => void) {
  const root = el("div"), ranked = "index" in result;
  root.append(el("h2", ranked ? "Keyword results" : "Exact identity lookup"));
  if (ranked && result.index.state !== "ready") { root.append(el("p", result.index.message, "knowledge-error")); return root; }
  root.append(el("p", ranked ? `${result.total} matches · Ranked results, not an exhaustive inventory` : `${result.total} exact matches · ${result.outcome}`, "knowledge-muted"));
  if (!result.coverage.complete) root.append(el("p", result.coverage.message, "knowledge-error"));
  if (!result.total) root.append(el("p", "No matches. Check your query and filters."));
  if (!ranked && result.outcome === "ambiguous") root.append(el("p", "This name or alias identifies more than one record. Inspect the matches before choosing an identity."));
  const split = el("div", undefined, "knowledge-split"), list = el("div", undefined, "knowledge-records"), detail = el("article", undefined, "knowledge-detail");
  detail.append(el("h2", "Inspect a result"), el("p", "Open a result to read the current record and its evidence. Citations below identify the searched revision."));
  for (const hit of result.hits) {
    const item = el("article", undefined, "knowledge-search-hit"), control = button(hit.record.title, () => open(hit.record.id, detail));
    item.append(control, el("p", `${hit.record.kind} · ${hit.record.type} · ${hit.record.lifecycle}`, "knowledge-muted"), el("pre", hit.snippet.text, "knowledge-body"));
    item.append(el("p", `Matched ${hit.matches.join(", ")}${hit.snippet.matchLocated === false ? " · opening excerpt, not match location" : hit.snippet.truncated ? " · excerpt" : ""}`), el("code", `${hit.citation.path}${hit.snippet.startLine !== null ? `:${hit.snippet.startLine}–${hit.snippet.endLine}` : ""} · revision ${hit.citation.revision}`));
    const citation = el("details"); citation.append(el("summary", "Citation and source locators"), el("pre", `${hit.citation.id}\nSHA-256: ${hit.citation.hash}${hit.attribution ? `\n${hit.attribution}` : ""}`));
    for (const source of hit.evidence) citation.append(el("p", `${source.path}:${source.start_line}–${source.end_line}`));
    if (hit.evidenceTruncated) citation.append(el("p", "More evidence is available in the full record."));
    item.append(citation); list.append(item);
  }
  split.append(list, detail); root.append(split);
  const pages = el("div", undefined, "knowledge-pagination");
  if (state.offset) pages.append(button("Previous", () => { state.offset = Math.max(0, state.offset - 20); load(); }));
  if (result.nextOffset !== null) pages.append(button("Next", () => { state.offset = result.nextOffset!; load(); }));
  root.append(pages); return root;
}
