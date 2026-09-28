import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { authorizeMemoryAccess } from "./access.js";
import type { MemoryCitation, MemoryProviderRuntime, MemoryReference, MemorySearchRequest } from "./memory-provider-types.js";
import type { StorageClient } from "./storage-client.js";
import { digest } from "./vault.js";
import type { LoadedRecord } from "./model.js";

export type MemoryServiceLane = {
  enqueue<T>(operation: () => Promise<T>): Promise<T>;
  drain(): Promise<void>;
  fence(): () => void;
};
const revision = (r: Pick<LoadedRecord, "revision" | "hash">) => `${r.revision}:${r.hash}`;
const reference = (r: Pick<LoadedRecord, "id" | "revision" | "hash">): MemoryReference => ({ providerId: "knowledge", id: r.id, revision: revision(r) });
const integer = (n: number | undefined, fallback: number, max: number) => {
  if (n === undefined) return fallback;
  if (!Number.isInteger(n) || n < 1 || n > max) throw Error(`Expected an integer from 1 to ${max}.`);
  return n;
};
const attribution = (origin?: string, who?: string) => `Origin: ${origin || "not recorded"}; attribution: ${who || "not recorded"}.`;

/** Shares storage and the feature service's lane; never creates a second vault. */
export function createKnowledgeMemoryRuntime(api: OpenClawPluginApi, storage: StorageClient | undefined, lane: MemoryServiceLane): MemoryProviderRuntime {
  let generation = 0, retiring = false;
  return {
    async open({ agentId, context }) {
      if (!storage) return { provider: null, error: "Knowledge memory requires a configured real vault; sample records are not memory." };
      const serviceFence = lane.fence(), openedGeneration = generation;
      const access = authorizeMemoryAccess(api, context, storage.config.agentId, agentId, storage.config.operatorRead);
      let closed = false;
      const check = () => {
        serviceFence(); access.assertCurrent();
        if (closed || retiring || generation !== openedGeneration) throw Error("Knowledge memory lease is closed or retiring.");
      };
      check();
      const guarded = { scope: access.scope, assertCurrent: check };
      const run = <T>(operation: () => Promise<T>) => lane.enqueue(async () => { check(); const result = await operation(); check(); return result; });
      return { provider: {
        capabilities: { sources: ["memory"], pagination: true, candidates: [], projectFilter: false },
        search: (request: MemorySearchRequest) => run(async () => {
          if (request.sources && !request.sources.includes("memory")) throw Error("Knowledge does not search session transcripts; use conversation-history tools.");
          if (request.activeProjectKeys?.length) throw Error("Knowledge has no curated project-key selection capability.");
          const limit = integer(request.maxResults, 20, 50);
          if (request.minScore !== undefined && !Number.isFinite(request.minScore)) throw Error("minScore must be finite.");
          const binding = digest(JSON.stringify([storage.config.vaultId, access.scope, request.query, request.minScore ?? null, request.sources ?? null]));
          let offset = 0, snapshot: string | undefined;
          if (request.cursor !== undefined) {
            if (request.cursor.length > 1000) throw Error("Invalid Knowledge search cursor.");
            let cursor;
            try { cursor = JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8")); } catch { throw Error("Invalid Knowledge search cursor."); }
            if (!cursor || cursor.binding !== binding || typeof cursor.snapshot !== "string" || !Number.isInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > 500) throw Error("Invalid Knowledge search cursor.");
            offset = cursor.offset; snapshot = cursor.snapshot;
          }
          const result = await storage.call("search", guarded, { query: request.query, offset, limit });
          if (result.index.state !== "ready" || result.index.lag || !result.index.snapshot) throw Error(result.index.message);
          if (snapshot && snapshot !== result.index.snapshot) throw Error("Knowledge search snapshot changed; restart without a cursor.");
          const nextCursor = result.nextOffset === null ? undefined : Buffer.from(JSON.stringify({ binding, snapshot: result.index.snapshot, offset: result.nextOffset })).toString("base64url");
          const omittedSessions = request.sources?.includes("sessions");
          return {
            hits: result.hits.filter(h => request.minScore === undefined || (h.score !== null && h.score >= request.minScore)).map(h => ({
              reference: reference({ id: h.record.id, revision: h.citation.revision, hash: h.citation.hash }),
              excerpt: `${h.record.title}\n${attribution(h.assertionOrigin, h.attribution)}\n${h.snippet.text}`,
              ...(h.score === null ? {} : { score: h.score }), source: "memory",
              citations: [{ label: `${h.record.title} (${h.citation.path})`, reference: reference(h.citation) }],
              // Evidence-backed is not synonymous with trusted automatic instruction/selection.
              automaticRecall: { eligible: false },
            })),
            ...(nextCursor ? { nextCursor } : {}),
            coverage: result.coverage.complete && !nextCursor && !omittedSessions ? "complete" as const : "partial" as const,
            warning: `${result.coverage.message}${omittedSessions ? " Session transcripts were not searched." : ""}`,
          };
        }),
        get: request => run(async () => {
          if (request.reference.providerId !== "knowledge" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,95}$/.test(request.reference.id) || request.reference.fragment !== undefined) throw Error("Invalid Knowledge record reference.");
          const from = integer(request.from, 1, 100000), count = integer(request.lines, 100, 200);
          const found = await storage.call("memoryGet", guarded, { id: request.reference.id, ...(request.reference.revision !== undefined ? { revision: request.reference.revision } : {}), from, count });
          if (found.status !== "ok") return { status: "not_found" as const };
          const r = found.record, ref = reference(r), nextFrom = from + found.lines;
          const citations: MemoryCitation[] = [{ label: `${r.title} (${r.path})`, reference: ref }, ...found.evidence.map(e => ({ label: `${e.path} sha256:${e.sha256}${e.start_line ? ` lines ${e.start_line}–${e.end_line ?? e.start_line}` : ""}` }))];
          return { status: "ok" as const, reference: ref, text: found.text, citations, from, lines: found.lines, truncated: nextFrom <= found.total, ...(nextFrom <= found.total ? { nextFrom } : {}) };
        }),
        health: () => run(async () => {
          const facts = await storage.call("memoryHealth", guarded);
          return { status: !facts.ontology ? "unavailable" as const : facts.issues ? "degraded" as const : "ready" as const,
            message: "Scoped vault validation; keyword index readiness is checked on search.",
            details: { records: facts.records, issues: facts.issues, retrieval: "keyword", index: "checked-on-search", scope: access.scope.visibility } };
        }),
        async close() { closed = true; },
      } };
    },
    prepareReload({ retireRuntime }) {
      if (retireRuntime) retiring = true;
      return { drain: () => lane.drain(), resume() { if (retireRuntime) retiring = false; } };
    },
    async closeMemorySearchManager({ agentId }) { if (agentId === storage?.config.agentId) { ++generation; await lane.drain(); } },
    async closeAllMemorySearchManagers() { ++generation; await lane.drain(); },
  };
}
