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
    const { metadata, raw, body, hash, ...summary } = r;
    for (const direction of directions) if (!input.direction || input.direction === direction) rows.push({ direction, record: summary,
      ...(r.kind === "relationship" ? { from: m.from!, to: m.to!, label: m.label! } : {}),
      evidence: (m.evidence ?? []).slice(0, 3), evidenceTruncated: (m.evidence?.length ?? 0) > 3 });
  }
  const offset = input.offset ?? 0, limit = input.limit ?? 20;
  return { connections: rows.slice(offset, offset + limit), total: rows.length, nextOffset: offset + limit < rows.length ? offset + limit : null,
    snapshot: digest(JSON.stringify(records.map(r => [r.id, r.hash]))) };
}
