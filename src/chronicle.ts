import type { DatabaseSync } from "node:sqlite";
import { digest, type SampleVault } from "./vault.js";
import type { LoadedRecord } from "./model.js";
import { eligible } from "./retrieval.js";
import { reconcileChronicle, chronologicalIds } from "./chronicle-index.js";
import { calendarDay, dateInterval, recordDate, sameTemporalDate, shiftDay, type TimeField } from "./temporal-query.js";
import { Check } from "typebox/value";
import { timeBounds } from "./temporal-query.js";
import { type ChronicleOutput, TimelineInput, DayInput } from "./chronicle-contract.js";

type Snapshot = Awaited<ReturnType<SampleVault["scan"]>>;

/** Render a compact source-addressable temporal result without exposing raw frontmatter. */
function item(record: LoadedRecord, field: TimeField, visible: Set<string>): ChronicleOutput["items"][number] {
  const date = recordDate(record, field)!;
  const { id, title, path, kind, type, revision, hash } = record;
  return { record: { id, title, path, kind, type, revision, hash }, date, dateField: field,
    precision: date.length === 10 ? "day" : "instant", summary: record.body.trim().slice(0, 1000),
    entities: (record.metadata.entities ?? []).filter(id => visible.has(id)),
    ...(record.metadata.source_page && visible.has(record.metadata.source_page) ? { sourcePage: record.metadata.source_page } : {}),
    evidenceCount: record.metadata.evidence?.length ?? 0 };
}

/** Validate a day/week query and compare timestamp calendar days in the requested zone. */
export function dayPredicate(input: DayInput): (value: string) => boolean {
  dateInterval(input.date);
  if (input.date.length !== 10) throw Error("date must be YYYY-MM-DD.");
  // Construct even for an empty result, so invalid zones never masquerade as no matches.
  calendarDay(input.date, input.timezone);
  const weekday = new Date(input.date).getUTCDay();
  const first = input.week ? shiftDay(input.date, -(weekday + 6) % 7) : input.date;
  const last = input.week ? shiftDay(first, 6) : first;
  return value => { const day = calendarDay(value, input.timezone); return day >= first && day <= last; };
}

/** Query one authoritative scoped snapshot through its rebuildable SQLite date index. */
export function chronicle(db: DatabaseSync, data: Snapshot, binding: string, input: TimelineInput, withdrawn = new Set<string>(), onDay?: DayInput): ChronicleOutput {
  const records = eligible(data, withdrawn, input.historical ?? false);
  const byId = new Map(records.map(r => [r.id, r])), visible = new Set(byId.keys());
  const predicate = onDay ? dayPredicate(onDay) : undefined;
  const field = input.timeField ?? "occurred_at";
  db.exec("BEGIN IMMEDIATE");
  let snapshot: string, ids: string[];
  try {
    snapshot = reconcileChronicle(db, records, binding);
    ids = chronologicalIds(db, binding, input);
    db.exec("COMMIT");
  } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
  // A cursor belongs to both a source snapshot and a particular query.
  snapshot = digest(JSON.stringify([snapshot, field, input.entity ?? null, input.kind ?? null,
    input.since ?? null, input.until ?? null, input.order ?? "desc", input.historical ?? false,
    onDay ? [onDay.date, onDay.week ?? false, onDay.timezone ?? "UTC"] : null]));
  if (input.snapshot && input.snapshot !== snapshot) throw Error("Knowledge changed; restart temporal pagination without offset or snapshot.");
  if (input.entity && (!byId.has(input.entity) || byId.get(input.entity)!.kind !== "page")) ids = [];
  // Group only explicit representations of the same source event with an identical date.
  // Dated claims about other events remain separate even when sourced from that meeting.
  const candidates = ids.map(id => byId.get(id)!).filter(r => r && (!input.kind || r.type === input.kind));
  const represented = new Set(candidates.filter(r => r.metadata.source_event && r.metadata.source_page &&
    sameTemporalDate(recordDate(r, field), byId.has(r.metadata.source_page) ? recordDate(byId.get(r.metadata.source_page)!, field) : undefined))
    .map(r => r.metadata.source_page!));
  const matched = candidates.filter(r =>
    (field !== "occurred_at" || !represented.has(r.id)) &&
    (!predicate || predicate(recordDate(r, field)!)));
  const offset = input.offset ?? 0, limit = input.limit ?? 20;
  const result: ChronicleOutput = { items: [], total: matched.length, offset, nextOffset: null, snapshot, checkedAt: data.checkedAt,
    coverage: { complete: data.issues.length === 0, message: "Structured dated records only; undated records and Markdown-only timeline bullets are not inferred. Source dates retain their precision. " +
      (data.issues.length ? "Some authorized source material has validation issues; inspect diagnostics." : "") } };
  for (const record of matched.slice(offset, offset + limit)) {
    const row = item(record, field, visible);
    if (Buffer.byteLength(JSON.stringify({ ...result, items: [...result.items, row] }), "utf8") > 24 * 1024) {
      if (!result.items.length) throw Error("Temporal record exceeds response budget; inspect the record directly.");
      break;
    }
    result.items.push(row);
  }
  result.nextOffset = offset + result.items.length < matched.length ? offset + result.items.length : null;
  return result;
}

/** An operator can inspect an unprovisioned store without creating its files or database. */
export function emptyChronicle(input: TimelineInput, onDay?: DayInput): ChronicleOutput {
  if (!Check(TimelineInput, input) || (onDay && !Check(DayInput, onDay))) throw Error("Invalid temporal query input.");
  timeBounds(input);
  if (onDay) dayPredicate(onDay);
  const snapshot = digest(JSON.stringify(["unprovisioned", { ...input, offset: undefined, limit: undefined, snapshot: undefined }, onDay]));
  if (input.snapshot && input.snapshot !== snapshot) throw Error("Knowledge changed; restart temporal pagination without offset or snapshot.");
  return { items: [], total: 0, offset: input.offset ?? 0, nextOffset: null, snapshot, checkedAt: new Date().toISOString(),
    coverage: { complete: true, message: "This store has not been provisioned; no dated records are available." } };
}
