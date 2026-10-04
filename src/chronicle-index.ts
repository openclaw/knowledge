import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { LoadedRecord } from "./model.js";
import { digest } from "./vault.js";
import { dateInterval, recordDate, timeBounds, type TimeField, type TimeFilter } from "./temporal-query.js";

const fields: TimeField[] = ["occurred_at", "recorded_at", "updated_at", "due_at"];

/** Rebuildable, partition-bound date rows. This function runs in a storage transaction. */
export function reconcileChronicle(db: DatabaseSync, records: LoadedRecord[], binding: string): string {
  const tables = ["temporal_records_v1", "temporal_dates_v1", "temporal_entities_v1"];
  const complete = tables.every(name => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  db.exec("CREATE TABLE IF NOT EXISTS temporal_records_v1 (binding TEXT NOT NULL,id TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(binding,id)) STRICT;" +
    "CREATE TABLE IF NOT EXISTS temporal_dates_v1 (binding TEXT NOT NULL,id TEXT NOT NULL,field TEXT NOT NULL,value TEXT NOT NULL,start_ms INTEGER NOT NULL,end_ms INTEGER NOT NULL,PRIMARY KEY(binding,id,field)) STRICT;" +
    "CREATE INDEX IF NOT EXISTS temporal_range_v1 ON temporal_dates_v1(binding,field,start_ms,id);" +
    "CREATE TABLE IF NOT EXISTS temporal_entities_v1 (binding TEXT NOT NULL,id TEXT NOT NULL,entity TEXT NOT NULL,PRIMARY KEY(binding,id,entity)) STRICT;" +
    "CREATE INDEX IF NOT EXISTS temporal_entity_v1 ON temporal_entities_v1(binding,entity,id);");
  // A partially missing projection cannot use record hashes as proof of indexed dates.
  if (!complete) for (const table of tables) db.exec("DELETE FROM " + table);
  const wanted = new Map(records.map(r => [r.id, r]));
  // Reconcile only changed records; removals also clear dates and associations.
  for (const row of db.prepare("SELECT id,hash FROM temporal_records_v1 WHERE binding=?").all(binding)) {
    const record = wanted.get(String(row.id));
    if (record?.hash === row.hash) { wanted.delete(record.id); continue; }
    for (const table of ["temporal_dates_v1", "temporal_entities_v1", "temporal_records_v1"]) db.prepare("DELETE FROM " + table + " WHERE binding=? AND id=?").run(binding, row.id!);
  }
  const track = db.prepare("INSERT INTO temporal_records_v1 VALUES (?,?,?)");
  const date = db.prepare("INSERT INTO temporal_dates_v1 VALUES (?,?,?,?,?,?)");
  const entity = db.prepare("INSERT OR IGNORE INTO temporal_entities_v1 VALUES (?,?,?)");
  for (const record of wanted.values()) {
    track.run(binding, record.id, record.hash);
    for (const field of fields) {
      const value = recordDate(record, field);
      if (value) { const interval = dateInterval(value); date.run(binding, record.id, field, value, interval.start, interval.end); }
    }
    const m = record.metadata;
    for (const id of [record.id, ...(m.entities ?? []), m.owner, m.from, m.to, m.source_page]) if (id) entity.run(binding, record.id, id);
  }
  // Path/type changes must also invalidate pagination even though indexed dates may be unchanged.
  return digest(JSON.stringify([binding, records.map(r => [r.id, r.path, r.hash, r.type, String(r.revision)]).sort((a,b) => a[0].localeCompare(b[0]))]));
}

/** Select IDs using fixed SQL columns and bound values; callers enforce current eligibility. */
export function chronologicalIds(db: DatabaseSync, binding: string, input: TimeFilter & { entity?: string; order?: "asc" | "desc" }): string[] {
  const bounds = timeBounds(input), values: SQLInputValue[] = [binding, input.timeField ?? "occurred_at"];
  const where = ["d.binding=?", "d.field=?"];
  if (bounds.start !== null) { where.push("d.end_ms>=?"); values.push(bounds.start); }
  if (bounds.end !== null) { where.push("d.start_ms<=?"); values.push(bounds.end); }
  if (input.entity) {
    where.push("EXISTS (SELECT 1 FROM temporal_entities_v1 e WHERE e.binding=d.binding AND e.id=d.id AND e.entity=?)"); values.push(input.entity);
  }
  const direction = input.order === "asc" ? "ASC" : "DESC";
  return db.prepare("SELECT d.id FROM temporal_dates_v1 d WHERE " + where.join(" AND ") + " ORDER BY d.start_ms " + direction + ",d.id " + direction).all(...values).map(row => String(row.id));
}
