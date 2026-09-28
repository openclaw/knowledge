import { resolveLinks } from "./markdown-links.js";
import { claimCard } from "./claim-card.js";
import { recordSummary } from "./record-summary.js";
import type { Static } from "typebox";
import { ConnectionsInput, ConnectionsOutput } from "./connections-contract.js";
import { eligible } from "./retrieval.js";
import { digest, type SampleVault } from "./vault.js";

export function connections(data: Awaited<ReturnType<SampleVault["scan"]>>, input: Static<typeof ConnectionsInput>, withdrawn = new Set<string>()): Static<typeof ConnectionsOutput> {
  const records = eligible(data, withdrawn, input.historical ?? false);
  const rows: Static<typeof ConnectionsOutput>["connections"] = [];
  if (records.some(r => r.id === input.id)) for (const r of records) {
    const m = r.metadata, directions: Static<typeof ConnectionsOutput>["connections"][number]["direction"][] = [];
    if (r.kind === "relationship") { if (m.from === input.id) directions.push("outgoing"); if (m.to === input.id) directions.push("incoming"); }
    if (m.dependencies?.includes(input.id)) directions.push("dependents");
    if (r.kind === "claim" && (m.entities?.includes(input.id) || m.owner === input.id || m.source_page === input.id)) directions.push("claims");
    const summary = recordSummary(r);
    for (const direction of directions) if (!input.direction || input.direction === direction) rows.push({ direction, record: { ...summary, ...(input.includeCards && r.kind === "claim" ? { card: claimCard(r, records) } : {}) },
      ...(r.kind === "relationship" ? { from: m.from!, to: m.to!, label: m.label! } : {}),
      evidence: (m.evidence ?? []).slice(0, 3), evidenceTruncated: (m.evidence?.length ?? 0) > 3 });
  }
  // Document links are only resolved when the caller asks for them. Only the
  // current record's own links and links pointing at it produce rows.
  const current = records.find(r => r.id === input.id);
  const wantsLinks = !input.direction || input.direction === "links", wantsBacklinks = !input.direction || input.direction === "backlinks";
  if (current && (wantsLinks || wantsBacklinks)) for (const source of records) {
    if (source.id === current.id ? !wantsLinks : !wantsBacklinks) continue;
    const targets = new Set(resolveLinks(source, records).flatMap(link => link.id ? [link.id] : []));
    if (source.id === current.id) {
      for (const target of records) if (targets.has(target.id) && target.id !== source.id) rows.push({ direction: "links", record: recordSummary(target), label: "References", evidence: [], evidenceTruncated: false });
    } else if (targets.has(current.id)) rows.push({ direction: "backlinks", record: recordSummary(source), label: "Referenced by", evidence: [], evidenceTruncated: false });
  }
  const offset = input.offset ?? 0, limit = input.limit ?? 20;
  const page = rows.slice(offset, offset + limit);
  const endpointIds = new Set(page.filter(r => r.record.kind === "relationship").flatMap(r => [r.from, r.to]));
  return { connections: page, ...(input.includeEndpoints ? { endpoints: eligible(data, withdrawn, false).filter(r => endpointIds.has(r.id)).map(recordSummary) } : {}), total: rows.length, nextOffset: offset + limit < rows.length ? offset + limit : null,
    snapshot: digest(JSON.stringify(records.map(r => [r.id, r.path, r.hash]))) };
}
