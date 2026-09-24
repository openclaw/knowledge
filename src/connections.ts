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
    if (r.kind === "claim" && (m.entities?.includes(input.id) || m.owner === input.id)) directions.push("claims");
    const summary = recordSummary(r);
    for (const direction of directions) if (!input.direction || input.direction === direction) rows.push({ direction, record: { ...summary, ...(input.includeCards && r.kind === "claim" ? { card: claimCard(r, records) } : {}) },
      ...(r.kind === "relationship" ? { from: m.from!, to: m.to!, label: m.label! } : {}),
      evidence: (m.evidence ?? []).slice(0, 3), evidenceTruncated: (m.evidence?.length ?? 0) > 3 });
  }
  const current = records.find(r => r.id === input.id);
  if (current) for (const source of records) {
    const targets = new Set(resolveLinks(source, records).flatMap(link => link.id ? [link.id] : []));
    for (const target of records) if (targets.has(target.id) && source.id !== target.id) {
      const direction = source.id === current.id ? "links" : target.id === current.id ? "backlinks" : undefined;
      if (direction && (!input.direction || direction === input.direction)) rows.push({ direction, record: recordSummary(direction === "links" ? target : source), label: direction === "links" ? "References" : "Referenced by", evidence: [], evidenceTruncated: false });
    }
  }
  const offset = input.offset ?? 0, limit = input.limit ?? 20;
  return { connections: rows.slice(offset, offset + limit), total: rows.length, nextOffset: offset + limit < rows.length ? offset + limit : null,
    snapshot: digest(JSON.stringify(records.map(r => [r.id, r.path, r.hash]))) };
}
