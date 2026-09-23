# Keyword retrieval (v1)

Implemented by `knowledge_grep`, `knowledge_lookup` and the native **Search** tab.
No embeddings, remote services, query expansion, answer synthesis or regex engine.
The UI and agent use the same typed feature operations and storage authority.
**Records** / `knowledge_records` remains the exhaustive, paginated catalog;
ranked search never establishes that a vault inventory is complete.

## Query contract

| Operation/input | Meaning |
|---|---|
| `knowledge_grep({query})` | FTS5/BM25 over title, declared aliases and body; all literal word tokens must match |
| `mode: "any"` | Any literal word token may match |
| `mode: "phrase"` | Word tokens in order and adjacent within one field |
| `knowledge_lookup({query})` | Exact stable ID, full title or declared alias; `found`, `ambiguous`, or `missing` |
| `kind`, `type`, `tag` | Structural kind, ontology type/alias expansion, exact case-sensitive tag |
| `lifecycle` | `active` (default), `superseded`, or `all` (active + superseded only) |
| `limit`, `offset` | 1–50 results (default 20), offset 0–500; follow `nextOffset` with unchanged query/filters |

Keywords accept 1–64 Unicode word tokens within 500 characters. Punctuation is
separation; `OR`, `NOT`, column syntax and quotes are **not** executable FTS syntax.
Phrase mode is explicit. SQLite `unicode61 remove_diacritics 2` supplies
case/diacritic-insensitive keyword matching. There is no stemming, prefix search
or language-specific segmentation; unsegmented CJK substrings are not guaranteed.
Exact lookup accepts up to 200 characters. IDs are case-sensitive; names/aliases
use NFKC, lowercase, trimming and whitespace collapse (not fuzzy matching).
Ambiguity is computed before pagination, not inferred from a single returned hit.

Defaults include all active saved records. There is no approval or promotion step,
and legacy candidate/accepted metadata does not restrict discovery. Invalid/duplicate IDs, withdrawn records and records
with transitively unavailable structured dependencies/endpoints/entities are
excluded in every retrieval mode. `knowledge_record` and Records remain explicit
inspection surfaces for authoring/diagnostics, not ranked retrieval.
Authored prose without declared dependencies cannot be automatically redacted.

## Results and citations

Each hit carries a summary, visible lifecycle, exact-match fields or
keyword-match fields, attribution/assertion origin, and stable ID, path,
revision and SHA-256 of the observed original Markdown. The body/title/alias
snippet is at most **480 UTF-16 characters**, with zero-based start/end offsets
(end exclusive). Alias offsets address aliases joined by newlines. Body snippets
also carry **one-based original Markdown line ranges**, including frontmatter in
the line count. Title/alias snippets have null line locators. Context is centered
near the first match in the body if present, otherwise title/aliases; truncation
is explicit. Several distant matches may not all fit in one snippet.

At most three validated evidence locators are included, without duplicate source
excerpts; `evidenceTruncated` directs callers to record inspection. Citation hashes
identify the searched revision, not a guarantee that a later detail read is the
same revision. Compare hashes; use record/history operations to inspect content.
No generated HTML highlighting is rendered: UI snippets use `textContent`.

BM25 weights are title 8, aliases 6, body 1. Returned scores are positive (negated
SQLite BM25), with descending relevance and stable-ID tie breaking. Scores are
only comparable within the same query/filter/corpus snapshot. Scope **and filters
precede corpus statistics**, not post-ranking result filtering. Exact lookup is
not scored and never silently chooses among colliding names or aliases.

## Index authority, lag and failure

Markdown remains authoritative. Search first runs the existing scoped scan,
validation and observation path inside the storage service's trusted authority and
vault identity/generation fence. It never reads an index instead of reconciling.
SQLite projections live in the plugin's existing operational database; they are
not in the vault and are not shared with memory-core or lossless-claw.

Each trusted vault/scope has a separate FTS5 projection. A content fingerprint
includes scoped eligible IDs, hashes, observed revisions/paths and effective
ontology fingerprint. Changed content atomically replaces that projection.
A request-local filtered FTS5 corpus gives BM25 statistics over **only** eligible
selected records. Other scopes and records excluded by filters cannot affect
rank, counts or snippets. No native database handle survives the operation.
Sample mode uses an ephemeral in-memory database and does not write the sample.

- A published receipt still has `indexed:false`: this is publication-time state,
  meaning indexing is pending until search reconciles; not a failed save.
- Search is synchronous/read-through. `index.state:"ready", lag:false` means this
  query's projection matches its reconciled snapshot. `snapshot` is scoped and
  content-derived; compare it across pages and restart if it changes. The UI
  detects changed keyword snapshots rather than combining pages.
- Index construction/query failure returns `state:"unavailable", lag:null`,
  `total:null`, no hits, and a retry/inspection message. It never returns stale
  results or calls failed retrieval a successful empty result. Retry rebuilds;
  exact lookup and exhaustive listing do not depend on FTS5 availability.
- Authority, unsafe vault identity, publication conflicts and scan-limit failures
  reject the operation rather than becoming an empty or partial search.
- Validation issues set `coverage.complete:false` with an explicit diagnostic
  message. Zero valid matches does not imply that malformed source material was
  indexed successfully. Use Activity & issues for authorized source findings.

There is no background indexing worker, queued indexing success claim, or durable
index-failure log in this slice. Search itself reports current engine failures;
publication receipts disclose pending indexing. Index state is per read snapshot,
not a promise that the filesystem can never change after it has been read.

### Operational withdrawal safeguard

Every real-vault scoped observation retains IDs whose parsed envelope declares
`lifecycle:withdrawn` in `keyword_withdrawals_v1`, keyed by vault identity and
scope. Both retrieval paths consult it. A later stale active file, service restart
or FTS rebuild cannot clear an observed withdrawal. This table is **operational
state, not a disposable index**: preserve it in a full backup. This adds no
withdrawal/restore tool or authorization to erase history. It cannot protect a
withdrawal that this instance never observed, or survive loss of its operational
state. Invalid-envelope material is not interpreted as a valid withdrawal.

### Rebuild boundary

`keyword_fts_v1_<scope hash>` virtual tables and `keyword_state_v1` are rebuildable;
missing tables or changed fingerprints are rebuilt on the next search. Do **not**
drop the operational database to rebuild search: identities, receipts, history,
Git checkpoints and withdrawal safeguards are not projections. No admin rebuild
command is introduced. Restore identity/generation mismatch is rejected before
serving any stored projection, including after a configured vault replacement.

## Existing-solution preflight and departures

Reviewed gbrain at `7cdc3e30a898665a8c87b0c06937f6366f759f6c`:
[`keyword.ts`](https://github.com/garrytan/gbrain/blob/7cdc3e30a898665a8c87b0c06937f6366f759f6c/src/core/search/keyword.ts),
[`exact-lookup.ts`](https://github.com/garrytan/gbrain/blob/7cdc3e30a898665a8c87b0c06937f6366f759f6c/src/core/search/exact-lookup.ts),
`private-visibility.ts` and `projection-readiness.ts`.
Identity matches deserve an explicit route and caller filters must also constrain
identity lookup. Departures: Knowledge returns ambiguity rather than injecting one
identity into hybrid results; uses SQLite rather than PGLite/Postgres; and fails
closed on stale/failed retrieval rather than continuing an organic hybrid tier.
These follow v1 scope, local Markdown authority and the access contract.

Also inspected OpenClaw memory-core's `src/memory/manager-search.ts` (FTS5/BM25)
and lossless-claw's `src/store/fts5-sanitize.ts`, `src/db/features.ts` and FTS5
migration sites. Reuse is the maintained SQLite engine and literal-query/scoped
projection patterns, **not copied private modules, databases or a new dependency**.
This implementation uses explicit literal modes instead of accepting an advanced
query language whose escaping would need a separate public contract.
