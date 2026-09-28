import { Type, type Static } from "typebox";
import type { DatabaseSync } from "node:sqlite";
import type { LoadedRecord } from "./model.js";
import { claimCard } from "./claim-card.js";
import { Summary, CardSummary } from "./inspection-contract.js";
import { recordSummary } from "./record-summary.js";
import { text } from "./model.js";

const sequence = Type.Integer({ minimum: 0 });
export const RecentInput = Type.Object({
  groupBySource: Type.Optional(Type.Boolean()),
  includeEndpoints: Type.Optional(Type.Boolean()),
  sourceId: Type.Optional(text(96)), recordOffset: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  upperSequence: Type.Optional(sequence), beforeSequence: Type.Optional(sequence),
}, { additionalProperties: false });
export const RecentOutput = Type.Object({
  upperSequence: sequence,
  nextBefore: Type.Union([sequence, Type.Null()]),
  items: Type.Array(Type.Object({
    group: Type.Optional(Type.Object({ source: Summary, total: Type.Integer(), counts: Type.Record(Type.String(), Type.Integer()), records: Type.Array(Type.Object({ ...CardSummary.properties, change: Type.Optional(text(20)) }), {maxItems:20}), endpoints: Type.Optional(Type.Array(Summary, { maxItems: 40 })), truncated: Type.Boolean(), nextRecordOffset: Type.Optional(Type.Union([Type.Integer(), Type.Null()])), firstSaved: Type.Optional(text(40)), lastSaved: Type.Optional(text(40)) })),
    sequence, id: text(96), at: text(40), kind: text(40), type: text(64),
    change: Type.Union([Type.Literal("created"), Type.Literal("updated"), Type.Literal("observed"), Type.Literal("external"), Type.Literal("corrected"), Type.Literal("withdrawn")]),
    title: Type.Optional(text(200)), identityStatus: Type.Optional(text(20)), reason: Type.Optional(text(2000)),
    replacementId: Type.Optional(text(96)), replacementActive: Type.Optional(Type.Boolean()),
  }, { additionalProperties: false }), { maxItems: 50 }),
}, { additionalProperties: false });
type Item = Static<typeof RecentOutput>["items"][number];

/** Project exact published snapshots into logical events BEFORE cursor paging.
 * No timestamp heuristics or independently paginated receipt/history merging.
 * Earlier snapshots of inactive/dependency-hidden records stay in history only.
 */
export function recentActivity(db: DatabaseSync, scope: string, active: LoadedRecord[], input: Static<typeof RecentInput>, fixtureIds: string[] = []): Static<typeof RecentOutput> {
  const upperSequence = input.upperSequence ?? Number(db.prepare("SELECT COALESCE(MAX(sequence),0) AS n FROM history WHERE scope=?").get(scope)!.n);
  const byId = new Map(active.map(r => [r.id, r]));
  const sourceIds = Object.fromEntries(active.map(r => [r.id, r.kind === "page" && ["meeting", "source"].includes(r.type) ? r.id : r.metadata.source_page]).filter(([, id]) => typeof id === "string" && byId.has(id)));
  // Reuse this expensive JSON/history join in both event branches. Inlining it
  // makes SQLite reparse whole publication plans for each history row.
  const rows = db.prepare(`
    WITH published AS MATERIALIZED (
      SELECT m.request, m.receipt, j.value AS record,
        (SELECT MIN(h.sequence) FROM history h WHERE h.scope=m.scope
          AND h.id=json_extract(j.value,'$.id') AND h.hash=json_extract(j.value,'$.hash')
          AND h.revision=json_extract(j.value,'$.revision')
          AND h.provenance=json_extract(m.plan,'$.actor')) AS sequence
      FROM mutations m, json_each(COALESCE(json_extract(m.plan,'$.records'), json_array(json_extract(m.plan,'$.record')))) j
      WHERE m.scope=? AND m.state='published'
    ), plain AS MATERIALIZED (
      -- Sequence sets for the history branch. Joining history to the wide
      -- published rows scanned every published record per history event.
      SELECT sequence FROM published WHERE sequence IS NOT NULL AND json_extract(receipt,'$.operation') IS NULL
    ), any_published AS MATERIALIZED (
      SELECT sequence FROM published WHERE sequence IS NOT NULL
    ), events AS (
      SELECT MAX(sequence) AS sequence, json_extract(receipt,'$.targetId') AS id,
        json_extract(receipt,'$.at') AS at,
        CASE json_extract(receipt,'$.operation') WHEN 'correct' THEN 'corrected' ELSE 'withdrawn' END AS change,
        MAX(CASE WHEN json_extract(record,'$.id')=json_extract(receipt,'$.targetId') THEN json_extract(record,'$.kind') END) AS kind,
        MAX(CASE WHEN json_extract(record,'$.id')=json_extract(receipt,'$.targetId') THEN
          COALESCE(json_extract(record,'$.metadata.claim_kind'),json_extract(record,'$.metadata.type'),json_extract(record,'$.kind')) END) AS type,
        json_extract(receipt,'$.reason') AS reason, json_extract(receipt,'$.replacementId') AS replacementId,
        MAX(CASE WHEN json_extract(record,'$.id')=json_extract(receipt,'$.targetId') THEN json_extract(record,'$.title') END) AS title
      FROM published WHERE json_extract(receipt,'$.operation') IN ('correct','withdraw') GROUP BY request
      UNION ALL
      SELECT h.sequence, h.id, h.at,
        CASE WHEN h.sequence IN (SELECT sequence FROM plain) THEN CASE h.revision WHEN 1 THEN 'created' ELSE 'updated' END
          WHEN h.provenance='external-edit' THEN 'external' ELSE 'observed' END AS change,
        NULL, NULL, NULL, NULL, NULL
      FROM history h
      WHERE h.scope=? AND h.id IN (SELECT value FROM json_each(?))
        AND (h.sequence IN (SELECT sequence FROM plain) OR h.sequence NOT IN (SELECT sequence FROM any_published))
    ), visible AS (
      SELECT * FROM events WHERE sequence<=? AND id NOT IN (SELECT value FROM json_each(?))
    )
    ${input.groupBySource ? `, ranked AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY CASE WHEN change IN ('corrected','withdrawn') THEN 'event:'||sequence ELSE 'record:'||id END ORDER BY sequence DESC) AS rank FROM visible
    ), source_map AS MATERIALIZED (
      -- Parse the record-to-source map once; json_extract on the parameter per
      -- row reparsed the whole map for every history event.
      SELECT key AS id, value AS source FROM json_each(?)
    ), keyed AS (
      SELECT r.*, CASE WHEN r.change IN ('corrected','withdrawn') THEN 'event:'||r.sequence WHEN r.change='external' THEN 'external:'||r.id ELSE COALESCE('source:'||s.source, 'record:'||r.id) END AS group_key FROM ranked r LEFT JOIN source_map s ON s.id=r.id WHERE r.rank=1
    ), grouped AS (
      SELECT MAX(sequence) AS sequence, json_group_array(json_object('sequence',sequence,'id',id,'at',at,'change',change,'kind',kind,'type',type,'reason',reason,'replacementId',replacementId,'title',title)) AS members FROM keyed WHERE (? IS NULL OR group_key='source:'||?) GROUP BY group_key
    ) SELECT * FROM grouped WHERE sequence<? ORDER BY sequence DESC LIMIT ?` : 'SELECT * FROM visible WHERE sequence<? ORDER BY sequence DESC LIMIT ?'}
  `).all(scope, scope, JSON.stringify(active.map(r => r.id)), upperSequence, JSON.stringify(fixtureIds), ...(input.groupBySource ? [JSON.stringify(sourceIds), input.sourceId ?? null, input.sourceId ?? null] : []), input.beforeSequence ?? upperSequence + 1, (input.limit ?? 20) + 1);
  const items = rows.slice(0, input.limit ?? 20).map(raw => {
    const members = raw.members ? JSON.parse(String(raw.members)) as Array<Record<string, string | number | null>> : undefined;
    const row = members ? members.sort((a,b) => Number(b.sequence)-Number(a.sequence))[0] : raw;
    const current = byId.get(String(row.id));
    const item: Item = { sequence: Number(row.sequence), id: String(row.id), at: String(row.at),
      kind: String(row.kind ?? current!.kind), type: String(row.type ?? current!.type), change: row.change as Item["change"] };
    if (item.change === "corrected" || item.change === "withdrawn") {
      // Identify the historical item under an explicit lifecycle label, without
      // resurfacing its body or evidence as current knowledge.
      if (row.title) item.title = String(row.title);
      if (row.reason) item.reason = String(row.reason);
      if (row.replacementId) { item.replacementId = String(row.replacementId); item.replacementActive = byId.has(item.replacementId); const replacement = byId.get(item.replacementId); if (replacement) item.title = replacement.title; }
    } else if (current) { item.title = current.title; if (current.metadata.identity) item.identityStatus = current.metadata.identity.status; }
    const sourceId = sourceIds[item.id], source = sourceId ? byId.get(sourceId) : undefined;
    if (members && source && !['corrected','withdrawn','external'].includes(item.change)) {
      const records = members.map(m => byId.get(String(m.id))).filter((r): r is LoadedRecord => Boolean(r));
      const counts: Record<string, number> = {};
      const attendees = new Set<string>();
      for (const record of records) {
        if (record.metadata.label === 'attended' && record.metadata.to === source.id) attendees.add(record.metadata.from!);
        else { const kind = record.metadata.source_event ? 'sourceEvent' : record.kind === 'page' ? 'page' : record.type; counts[kind] = (counts[kind] ?? 0) + 1; }
      }
      if (attendees.size) counts.attendees = attendees.size;
      item.group = { source: recordSummary(source), total: records.length, counts, records: records.slice(input.recordOffset ?? 0, (input.recordOffset ?? 0) + 20).map(r => ({ ...recordSummary(r), change: String(members.find(member => member.id === r.id)?.change ?? "observed"), ...(r.kind === "claim" ? { card: claimCard(r, active) } : {}) })), truncated: records.length > (input.recordOffset ?? 0) + 20, nextRecordOffset: records.length > (input.recordOffset ?? 0) + 20 ? (input.recordOffset ?? 0) + 20 : null, firstSaved: String(members.at(-1)!.at), lastSaved: String(members[0].at) };
      if (input.includeEndpoints) {
        const ids = new Set(item.group.records.filter(r => r.kind === "relationship").flatMap(r => [r.from, r.to]));
        item.group.endpoints = active.filter(r => ids.has(r.id)).map(recordSummary);
      }
    }
    return item;
  });
  return { items, upperSequence, nextBefore: rows.length > items.length ? items.at(-1)!.sequence : null };
}
