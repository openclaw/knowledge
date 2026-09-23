import { observeLifecycleGuards } from "./lifecycle.js";
import { activeNow } from "./temporal.js";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Check } from "typebox/value";
import type { LoadedRecord } from "./model.js";
import { expandTypes } from "./ontology.js";
import { digest, type SampleVault } from "./vault.js";
import { SearchInput, LookupInput, type SearchOutput, type LookupOutput } from "./retrieval-contract.js";

type Snapshot = Awaited<ReturnType<SampleVault["scan"]>>;
type Hit = SearchOutput["hits"][number];
const normalize = (value: string) => value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();

/** Operational safeguards, NOT a rebuildable projection. Observing withdrawal is irreversible here. */
export function observeWithdrawals(db: DatabaseSync, records: LoadedRecord[], binding: string) {
  observeLifecycleGuards(db, records, binding);
  db.exec("CREATE TABLE IF NOT EXISTS keyword_withdrawals_v1 (binding TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(binding,id)) STRICT");
  const insert = db.prepare("INSERT OR IGNORE INTO keyword_withdrawals_v1 VALUES (?,?)");
  // A duplicate/invalid record cannot safely clear an existing withdrawal either.
  for (const r of records) if (r.lifecycle === "withdrawn") insert.run(binding, r.id);
}
export function withdrawnIds(db: DatabaseSync, binding: string): Set<string> {
  return new Set(db.prepare("SELECT id FROM keyword_withdrawals_v1 WHERE binding=?").all(binding).map(r => String(r.id)));
}

/** Remove unavailable dependencies transitively; do not leak a hidden endpoint through its edge/prose. */
export function eligible(data: Snapshot, withdrawn = new Set<string>(), historical = true) {
  const counts = new Map<string, number>();
  for (const r of data.records) counts.set(r.id, (counts.get(r.id) ?? 0) + 1);
  const allowed = new Map(data.records.filter(r => r.valid && counts.get(r.id) === 1 && r.lifecycle !== "withdrawn" && !withdrawn.has(r.id) && (historical || activeNow(r.metadata))).map(r => [r.id, r]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, r] of allowed) {
      const refs = [...(r.metadata.dependencies ?? []), ...(r.metadata.entities ?? []), ...[r.metadata.from, r.metadata.to, r.metadata.owner].filter((s): s is string => Boolean(s))];
      if (refs.some(ref => !allowed.has(ref))) { allowed.delete(id); changed = true; }
    }
  }
  return [...allowed.values()];
}
function filtered(data: Snapshot, records: LoadedRecord[], input: LookupInput | SearchInput) {
  const types = input.type ? expandTypes(data.ontology, input.type) : null;
  return records.filter(r => (!input.kind || r.kind === input.kind) && (!types || (r.kind === "page" ? types.has(r.type) : r.type === input.type)) &&
    (!input.tag || r.metadata.tags?.includes(input.tag)) &&
    (input.lifecycle === "all" || r.lifecycle === (input.lifecycle ?? "active")));
}
const coverage = (data: Snapshot) => ({ complete: data.issues.length === 0, message: data.issues.length ? "Some authorized source material has validation issues. Invalid, ambiguous, withdrawn and dependent records are excluded; inspect Activity & issues. Results do not establish a complete vault inventory." : "Current eligible scoped records only. Ranked search is not exhaustive vault listing." });
function hit(r: LoadedRecord, field: Hit["snippet"]["field"], at: number, matches: string[], score: number | null): Hit {
  const value = field === "body" ? r.body : field === "title" ? r.title : (r.metadata.aliases ?? []).join("\n");
  let start = Math.max(0, at - 100), end = Math.min(value.length, start + 480);
  // Do not split UTF-16 surrogate pairs at the snippet boundaries.
  if (start && /[\uDC00-\uDFFF]/.test(value[start] ?? "")) start--;
  if (end < value.length && /[\uDC00-\uDFFF]/.test(value[end] ?? "")) end--;
  if (end - start > 480) end--;
  const bodyStart = r.raw.length - r.body.length;
  const line = (offset: number) => r.raw.slice(0, bodyStart + offset).split("\n").length;
  const { metadata, body, raw, hash, ...record } = r;
  return {
    record, citation: { id: r.id, path: r.path, revision: r.revision, hash },
    snippet: { field, text: value.slice(start, end), start, end, startLine: field === "body" ? line(start) : null, endLine: field === "body" ? line(Math.max(start, end - 1)) : null, truncated: start > 0 || end < value.length },
    matches, score, attribution: metadata.attribution ?? "", assertionOrigin: metadata.assertion_origin ?? "",
    evidence: (metadata.evidence ?? []).slice(0, 3).map(({ path, sha256, start_line, end_line }) => ({ path, sha256, ...(start_line !== undefined ? { start_line } : {}), ...(end_line !== undefined ? { end_line } : {}) })), evidenceTruncated: (metadata.evidence?.length ?? 0) > 3,
  };
}
export function exactLookup(data: Snapshot, input: LookupInput, withdrawn = new Set<string>()): LookupOutput {
  if (!Check(LookupInput, input) || !input.query.trim()) throw Error("Lookup requires a nonempty exact ID, name or alias and valid filters.");
  const query = normalize(input.query);
  const matches = filtered(data, eligible(data, withdrawn, input.lifecycle !== undefined && input.lifecycle !== "active"), input).flatMap(r => {
    const fields = [...(r.id === input.query.trim() ? ["id"] : []), ...(normalize(r.title) === query ? ["title"] : []), ...((r.metadata.aliases ?? []).some(alias => normalize(alias) === query) ? ["aliases"] : [])];
    const field = fields.includes("title") ? "title" : fields.includes("aliases") ? "aliases" : "body";
    const at = field === "aliases" ? (r.metadata.aliases ?? []).join("\n").indexOf((r.metadata.aliases ?? []).find(alias => normalize(alias) === query)!) : 0;
    return fields.length ? [hit(r, field, at, fields, null)] : [];
  }).sort((a, b) => a.record.id.localeCompare(b.record.id));
  const offset = input.offset ?? 0, limit = input.limit ?? 20;
  return { hits: matches.slice(offset, offset + limit), total: matches.length, outcome: matches.length === 0 ? "missing" : matches.length === 1 ? "found" : "ambiguous", offset, nextOffset: offset + limit < matches.length ? offset + limit : null, checkedAt: data.checkedAt, coverage: coverage(data) };
}

/** Deliberately literal modes, never raw FTS syntax/SQL/regex. Punctuation is token separation. */
export function keywordExpression(input: SearchInput): string {
  if (!Check(SearchInput, input)) throw Error("Invalid keyword search input.");
  const tokens = input.query.match(/[\p{L}\p{N}\p{M}]+/gu) ?? [];
  if (!tokens.length || tokens.length > 64) throw Error("Keyword search requires 1–64 word tokens. Use exact lookup for a name or ID.");
  return input.mode === "phrase" ? `"${tokens.join(" ")}"` : tokens.map(t => `"${t}"`).join(input.mode === "any" ? " OR " : " AND ");
}

/** Called only inside the storage authority/identity fence, using the latest validated snapshot. */
export function keywordSearch(db: DatabaseSync, data: Snapshot, input: SearchInput, binding: string, generation: string, withdrawn = new Set<string>()): SearchOutput {
  const expression = keywordExpression(input), offset = input.offset ?? 0, limit = input.limit ?? 20;
  const base = { mode: "keyword" as const, queryMode: input.mode ?? "all", offset, checkedAt: data.checkedAt, coverage: coverage(data) };
  const records = eligible(data, withdrawn, input.lifecycle !== undefined && input.lifecycle !== "active"), selected = filtered(data, records, input);
  const table = `keyword_fts_v1_${digest(binding)}`;
  const snapshot = digest(JSON.stringify([generation, data.ontology?.fingerprint, records.map(r => [r.id, r.path, r.hash, r.revision])]));
  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec("CREATE TABLE IF NOT EXISTS keyword_state_v1 (binding TEXT PRIMARY KEY, snapshot TEXT NOT NULL, indexed_at TEXT NOT NULL) STRICT");
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table);
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING fts5(id UNINDEXED, title, aliases, body, tokenize='unicode61 remove_diacritics 2')`);
    const state = db.prepare("SELECT * FROM keyword_state_v1 WHERE binding=?").get(binding);
    let indexedAt = String(state?.indexed_at ?? new Date().toISOString());
    if (!exists || state?.snapshot !== snapshot) {
      db.exec(`DELETE FROM ${table}`);
      const insert = db.prepare(`INSERT INTO ${table}(id,title,aliases,body) VALUES (?,?,?,?)`);
      for (const r of records) insert.run(r.id, r.title, (r.metadata.aliases ?? []).join("\n"), r.body);
      indexedAt = new Date().toISOString();
      db.prepare("INSERT OR REPLACE INTO keyword_state_v1 VALUES (?,?,?)").run(binding, snapshot, indexedAt);
    }
    // A separate filtered corpus ensures BM25 statistics cannot be influenced by
    // inaccessible scopes OR records excluded by the caller's filters.
    db.exec("DROP TABLE IF EXISTS temp.keyword_query_v1");
    db.exec("CREATE VIRTUAL TABLE temp.keyword_query_v1 USING fts5(id UNINDEXED, title, aliases, body, tokenize='unicode61 remove_diacritics 2')");
    const insertQuery = db.prepare(`INSERT INTO temp.keyword_query_v1 SELECT id,title,aliases,body FROM ${table} WHERE id=?`);
    for (const r of selected) insertQuery.run(r.id);
    // Unpredictable delimiters checked against the corpus prevent authored marker injection.
    let marker: string;
    do { marker = randomUUID(); } while (selected.some(r => [r.title, r.body, ...(r.metadata.aliases ?? [])].some(v => v.includes(marker))));
    const total = Number(db.prepare("SELECT count(*) AS n FROM keyword_query_v1 WHERE keyword_query_v1 MATCH ?").get(expression)!.n);
    const rows = db.prepare(`SELECT id,bm25(keyword_query_v1,0,8,6,1) AS score,
      highlight(keyword_query_v1,1,?,'') AS title, highlight(keyword_query_v1,2,?,'') AS aliases, highlight(keyword_query_v1,3,?,'') AS body
      FROM keyword_query_v1 WHERE keyword_query_v1 MATCH ? ORDER BY score,id LIMIT ? OFFSET ?`).all(marker, marker, marker, expression, limit, offset);
    const byId = new Map(selected.map(r => [r.id, r]));
    const hits = rows.map(row => {
      const fields = (["title", "aliases", "body"] as const).filter(field => String(row[field]).includes(marker));
      const field = fields.includes("body") ? "body" : fields[0] ?? "title";
      return hit(byId.get(String(row.id))!, field, Math.max(0, String(row[field]).indexOf(marker)), fields, -Number(row.score));
    });
    db.exec("DROP TABLE temp.keyword_query_v1; COMMIT");
    return { ...base, hits, total, nextOffset: offset + limit < total ? offset + limit : null, index: { state: "ready", lag: false, snapshot, indexedAt, message: "Indexed from the current reconciled scope. Higher BM25 scores rank first; compare scores only within this query and snapshot." } };
  } catch {
    if (db.isTransaction) db.exec("ROLLBACK");
    return { ...base, hits: [], total: null, nextOffset: null, index: { state: "unavailable", lag: null, snapshot: null, indexedAt: null, message: "Keyword indexing/query failed; no stale results returned. Retry search to rebuild or inspect the plugin-owned SQLite state. Exact lookup and record listing remain available." } };
  }
}
