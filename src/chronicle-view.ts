import type { ChronicleOutput, TimelineInput } from "./chronicle-contract.js";
import { validTemporalDate } from "./temporal-query.js";
import { formatSourceDate } from "./temporal.js";

export type TemporalSelection = { since: string; until: string; timeField: NonNullable<TimelineInput["timeField"]>; entity: string };
const fields = { occurred_at: "Occurred", recorded_at: "Recorded", updated_at: "Updated", due_at: "Due" } as const;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
const button = (text: string, run: () => void, className = "knowledge-button") => { const node = el("button", text, className); node.type = "button"; node.onclick = run; return node; };

/** Validate explicit dates without silently widening an invalid query. */
export function temporalSelectionError(value: TemporalSelection): string {
  for (const key of ["since", "until"] as const) if (value[key] && !validTemporalDate(value[key])) return `${key === "since" ? "Since" : "Until"} must be a real YYYY-MM-DD date or ISO timestamp with seconds and an explicit timezone.`;
  const end = Date.parse(value.until) + (value.until.length === 10 ? 86_400_000 - 1 : 0);
  return value.since && value.until && Date.parse(value.since) > end ? "Since must not be after Until." : "";
}

/** Build shared date predicates; entity filtering belongs only to Timeline. */
export function temporalQuery(value: TemporalSelection) {
  return { timeField: value.timeField, ...(value.since ? { since: value.since } : {}), ...(value.until ? { until: value.until } : {}) };
}

/** Explicit-submit filters keep draft edits intact during background refreshes. */
export function temporalFilterForm(value: TemporalSelection, timeline: boolean, apply: (next: TemporalSelection) => void): HTMLFormElement {
  const form = el("form", undefined, "knowledge-temporal-filters");
  form.setAttribute("aria-label", timeline ? "Timeline filters" : "Search date filters");
  const wrap = (name: string, control: HTMLElement) => { const label = el("label", name); label.append(control); form.append(label); };
  const field = el("select"); field.name = "timeField";
  for (const [value, name] of Object.entries(fields)) { const option = el("option", `${name} (${value})`); option.value = value; field.append(option); }
  field.value = value.timeField; wrap("Date field", field);
  // Text inputs accept both authored calendar dates and timezone-bearing instants.
  const inputs = { since: el("input"), until: el("input"), entity: el("input") };
  for (const key of ["since", "until", ...(timeline ? ["entity" as const] : [])] as const) {
    const input = inputs[key]; input.name = key; input.value = value[key]; input.type = "text"; input.maxLength = key === "entity" ? 96 : 40;
    input.placeholder = key === "entity" ? "Page ID (optional)" : "YYYY-MM-DD or ISO timestamp"; wrap(key === "entity" ? "Entity page ID" : key === "since" ? "Since (inclusive)" : "Until (inclusive)", input);
  }
  const submit = el("button", "Apply dates"); submit.type = "submit"; if (timeline) submit.textContent = "Apply filters";
  const reset = button("Clear filters", () => apply({ since: "", until: "", timeField: "occurred_at", entity: "" }), "knowledge-quiet");
  const help = el("p", "Dates use UTC range boundaries; Until includes the whole calendar day. Occurred never falls back to recorded time.", "knowledge-muted knowledge-temporal-help");
  const error = el("p", "", "knowledge-error knowledge-temporal-help"); error.setAttribute("role", "alert");
  form.append(submit, reset, help, error);
  form.onsubmit = event => {
    event.preventDefault();
    const next = { since: inputs.since.value.trim(), until: inputs.until.value.trim(), timeField: field.value as TemporalSelection["timeField"], entity: timeline ? inputs.entity.value.trim() : value.entity };
    error.textContent = temporalSelectionError(next); if (!error.textContent) apply(next);
  };
  return form;
}

/** Render only returned records and provenance; pagination preserves the response fence. */
export function chronicleView(result: ChronicleOutput, actions: { open: (id: string) => void; page: (offset: number) => void; restart: () => void; previous?: number }): HTMLElement {
  const view = el("section", undefined, "knowledge-timeline"), list = el("div", undefined, "knowledge-surface");
  view.append(el("h2", "Timeline"), el("p", `${result.coverage.complete ? "Coverage" : "Partial coverage"}: ${result.coverage.message}`, result.coverage.complete ? "knowledge-muted" : "knowledge-notice"));
  view.append(el("p", `Checked ${formatSourceDate(result.checkedAt)} · newest first`, "knowledge-muted"));
  // Each row keeps its exact record address and optional source-page address.
  for (const item of result.items) {
    const row = el("article", undefined, "knowledge-timeline-row"); row.dataset.readingKey = `timeline:${item.record.id}`;
    const date = el("time", `${fields[item.dateField]} ${formatSourceDate(item.date)}${item.precision === "day" ? " · date only" : ""}`); date.dateTime = item.date; date.title = item.date;
    row.append(date, button(item.record.title, () => actions.open(item.record.id), "knowledge-record-link"), el("p", item.summary));
    const provenance = el("div", undefined, "knowledge-timeline-provenance");
    provenance.append(el("small", `${item.record.type} · revision ${item.record.revision} · ${item.record.path} · ${item.evidenceCount} evidence ${item.evidenceCount === 1 ? "citation" : "citations"}`));
    if (item.sourcePage) provenance.append(button("Open source page", () => actions.open(item.sourcePage!), "knowledge-inline-link"));
    provenance.append(button("Inspect record & evidence", () => actions.open(item.record.id), "knowledge-inline-link"));
    row.append(provenance); list.append(row);
  }
  if (!result.items.length) list.append(el("p", "No eligible dated records in this range. This does not establish that nothing happened.", "knowledge-empty"));
  const pages = el("div", undefined, "knowledge-pagination");
  pages.append(el("span", `${result.items.length ? result.offset + 1 : 0}–${result.offset + result.items.length} of ${result.total.toLocaleString()}`));
  const previous = button(actions.previous === undefined && result.offset ? "First" : "Previous", () => actions.page(actions.previous ?? 0)); previous.disabled = !result.offset;
  const next = button("Next", () => actions.page(result.nextOffset!)); next.disabled = result.nextOffset === null;
  pages.append(previous, next, button("Refresh timeline", actions.restart, "knowledge-quiet")); list.append(pages); view.append(list);
  const snapshot = el("details", undefined, "knowledge-muted"); snapshot.append(el("summary", "Snapshot"), el("code", result.snapshot)); view.append(snapshot);
  return view;
}
