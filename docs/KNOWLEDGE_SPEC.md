# Knowledge: OpenClaw Plugin Specification

**Version:** 0.4
**Date:** 2026-09-22
**Status:** Design specification; not implemented. API names and compact signatures are proposed, not a compatibility commitment.

> **V1 scope:** [KNOWLEDGE_SCOPE.md](KNOWLEDGE_SCOPE.md) governs release scope. This specification details the editable-vault, evidence, publication, and recovery contracts. Tool and skill packaging remain proposals; features marked follow-up are not release prerequisites.

## 1. Purpose

Knowledge is a native OpenClaw code plugin for durable, evidence-backed knowledge about people, organizations, projects, ideas, decisions, commitments, and events.

It combines deterministic storage and retrieval tools with agent-executed workflows. The host agent performs interpretation, extraction, query reformulation, and synthesis; the plugin preserves records, evidence, relationships, revisions, and write history.

OpenClaw Control UI is the primary human interface: begin with a native Knowledge sidebar page and grow inspection/editing views alongside the backend capabilities. Markdown is the portable authority, not a requirement to use an external knowledge application. Obsidian remains an optional editor.

The design draws on gbrain's knowledge model and, importantly, its ingestion and operating skills. It is neither a gbrain adapter nor a compatible reimplementation. Removing gbrain's internal reasoning runtime does not remove the need for detailed workflow instructions.

Knowledge is intended to replace memory-wiki's knowledge-vault role, not depend on it or reproduce all its features. Selected utilities and regression cases may be adapted; its compiled-page authority model is not Knowledge's storage contract. Replacement does not require feature parity, automatic migration, or ownership of the memory/context-engine slots.

This document consolidates the revised proposal, including the deeper skills review. Requirements below describe intended behavior. Items explicitly marked **proposed**, **optional**, or **open** retain that status; approval to write this specification does not resolve those choices.

## 2. Scope and boundaries

### 2.1 Baseline scope

- One logical knowledge store per OpenClaw agent.
- An authoritative editable Markdown vault containing claims, pages, entity profiles, and relationships, with retained evidence and mutation history.
- A native Knowledge sidebar page with Records, Schemas, and Activity & issues views, basic page editing, and live refresh of actual service state.
- Exact ID/name/alias lookup, keyword retrieval, filters, citations, and separate exhaustive listing; embeddings are a follow-up.
- One default taxonomy with locally configurable types, relationship names, and filing conventions, plus definition validation.
- Explicit remembering, correction, withdrawal, and requested ingestion.
- Complete text/document and meeting-transcript workflows, using available host media extraction capabilities and reporting partial outcomes when unavailable.
- Task-appropriate skills whose detailed instructions load on demand; the eight proposed entry points are not a release requirement.
- Durable, resumable progress for multi-record ingestion.
- Coexistence with existing memory and the selected context engine.
- One vault and one OpenClaw publishing instance per agent; external editors are supported, user-managed transport is allowed, and distributed autonomous publishing is not guaranteed.

### 2.2 Non-goals

- Taking the memory slot or registering a context engine.
- Replacing, migrating, or automatically synchronizing `MEMORY.md`, `USER.md`, or existing conversation memory.
- Source mounts, brain selection, repository federation, or a model-facing source-routing API.
- An internal LLM, extraction service, synthesis agent, job scheduler, or agent-management runtime.
- A separate MCP server, OAuth service, or remote-client platform.
- Arbitrary graph queries, generated SQL, ontology distribution/automatic migration, or specialized code intelligence. Named/versioned local ontology composition is included.
- Embeddings, reranking, query expansion, multi-hop/graph-assisted retrieval, proactive recall, and scheduled dreaming in v1; these are follow-up candidates.
- Automatic Git/cloud synchronization, multi-machine writers, or a sophisticated automatic merge service.
- Built-in email/recorder/account connectors, paid enrichment dependencies, or mandatory cloud storage.
- Task execution or reminders merely because a commitment was captured.
- Physical erasure, automatic restoration, or bulk destructive tools in the initial tool surface.
- A separate frontend application, generalized dashboard framework, graph visualization, rich-text editor, or visual schema builder in the foundation. The native Knowledge page is required; the earlier proposal dashboard remains only a design artifact.

### 2.3 Responsibility split

| Layer | Owns | Does not own |
|---|---|---|
| Shared service and operation contracts | Persistence, retrieval, evidence, revisions, links, receipts, history, and access enforcement for UI and agent entry points | Deciding what is true or worth saving |
| Native Control UI | Browse/edit knowledge and inspect schemas, evidence, activity, progress, and failures through shared operations | Direct filesystem/SQLite access, separate persistence rules, or client-side authority enforcement |
| Skills | Intake, interpretation, verification, entity resolution, correction, and curation procedures | Storage guarantees or another backend API |
| Hooks | Short operating guidance and optional bounded lifecycle assistance | Compaction, silent extraction, or a second reasoning agent |
| OpenClaw host | Agent execution, model access, scheduling, acquisition capabilities, and tool authority | Implicit completion of Knowledge-specific workflows |

## 3. Core invariants

1. **Success means published and receipted.** A successful mutation has durably published its authoritative record changes and committed its receipt, audit entry, and applicable ingestion associations. Accepted recovery work is not success; derived indexing may remain pending if disclosed. Files and SQLite do not share an atomic transaction (§7.2).
2. **Evidence remains inspectable.** Claims retain attribution and usable evidence references. Summaries and interpretations remain distinguishable from original material.
3. **Resolve before creating.** Inspect existing identities and plausible duplicates. Similarity alone never silently merges entities or supersedes claims.
4. **Corrections are explicit.** Preserve the old claim and its evidence; record why a replacement or withdrawal occurred.
5. **Concurrent edits do not silently overwrite.** Existing-record mutations require revision and file-content checks; edits throughout authoritative documents and unknown user metadata are preserved or surfaced as conflicts (§7.3).
6. **Retries do not duplicate work.** Request identities and ingestion progress survive interruption.
7. **Host context determines access.** A model-supplied agent ID, source selector, or session reference cannot grant authority.
8. **Workflow completion is stronger than write completion.** A saved meeting page alone is not a completed ingestion.
9. **Skills are procedures, not enforcement boundaries.** Storage, access control, revisions, and structural validation belong in code; semantic judgments remain agent responsibilities.
10. **Bundling is not activation.** Installing skills does not enable ambient capture, connector monitoring, paid enrichment, or background jobs.
11. **Derived state never outranks the vault.** Indexes must match vault identity and compatible publication state; reject stale publishers and incompatible snapshots after restore or replacement (§7.4).
12. **Capabilities ship with inspection.** Each feature exposes its authorized inputs, durable outputs, state, and failures in the native UI as well as appropriate operations. Events trigger refresh; durable records, receipts, and checkpoints establish truth.

## 4. Data model

| Record | Purpose | Essential properties |
|---|---|---|
| Fact | One attributed claim | Opaque ID, revision, text, kind, assertion origin, attribution, evidence, entity references, validity/expiry, lifecycle state |
| Page | A document, note, meeting, or entity profile | Opaque ID, unique slug within its authorized namespace, revision, title, Markdown body, type, tags, optional aliases |
| Entity | A typed page for a person, organization, project, or topic | Same page identity; aliases, linked facts, relationships, and derived event views |
| Relationship | A directed labeled connection between pages/entities | Opaque edge ID, revision, endpoints, label, evidence, lifecycle state, optional validity dates |
| Evidence artifact | Retained original or derived source material | Artifact ID, immutable content hash/version, media type, origin, byte length, access scope, retention mode |
| History entry | Audit of a committed mutation | Mutation ID, action, affected ID/revision, timestamp, reason where applicable, host-attached origin |
| Ingestion record | Durable progress for a multi-record workflow | Import key, revision, artifact references, planned items/checkpoints, committed outputs, verification findings, status |

### 4.1 Facts and temporal meaning

Proposed fact kinds are `fact`, `preference`, `decision`, `commitment`, `event`, and `belief`. Facts may reference multiple entities so a shared event need not be copied into separate claims for each participant.

Keep these concepts distinct:

- `recorded_at`: when the plugin stored the record.
- `updated_at`: when the record changed.
- `occurred_at`: when an event or meeting happened.
- `valid_from` / `valid_until`: when a claim or relationship applies.
- `expires_at`: when a fact should cease participating in active retrieval.

Unknown dates remain unknown. A commitment may have a known owner and optional `due_at`; capturing it does not schedule or execute it. Fact states include active, superseded, and withdrawn; expiry also excludes a fact from active retrieval.

Created records are immediately available, with no candidate/accepted state, promotion, or approval workflow. Lifecycle (`active` / `superseded` / `withdrawn`) remains independent of publication progress (§7.2). Unresolved identities remain explicit through attribution and evidence, not an approval gate.

Assertion origin distinguishes a source statement, a user belief, and an agent inference, independently of topical claim kind. Preserve attribution and evidence rather than collapsing extraction confidence, speaker confidence, evidential support, and validity into one score. Numerical confidence modeling is not required for v1.

### 4.2 Pages, entities, and derived state

Entity pages present a current, cited understanding rather than an ever-growing dump. Updates must preserve evidence and distinguish assessments from attributed claims. Updating a page does not implicitly overwrite its linked facts.

A project is an entity type encompassing ongoing initiatives and workstreams, not only software or work with a repository. Use project status (such as active, paused, completed, or cancelled) separately from record lifecycle; completing a project does not change its identity or withdraw its record. Do not introduce a separate workstream type without an evidenced semantic distinction.

Aliases assist resolution but do not prove identity. Ambiguous names produce candidates; alias collisions must not silently reassign a name.

Meeting pages additionally carry occurrence time/timezone when known, participant references, evidence artifacts and ranges, ingestion identity, and completeness metadata.

Entity timelines should be derived from linked meetings/events and temporal facts. Store a relationship once and expose incoming/outgoing views; do not duplicate the whole meeting across every entity page.

### 4.3 Evidence and dependencies

An evidence reference should identify the artifact, immutable version or hash, and a stable segment, line, page, or time locator. Include an exact quote where useful. Non-artifact references may identify a host message, URL, or file, but must not be represented as durably retained unless future access is guaranteed.

Transcripts derived from audio reference the parent artifact. Preserve original text, speaker labels, timestamps, and provenance separately from interpretation. Derived claims and pages retain machine-readable dependency references so later corrections can find affected outputs.

A recording ID or origin URL is provenance inside the one store, not a gbrain-style source namespace.

### 4.4 Portable serialization and local schema

Document a versioned Markdown/frontmatter representation for pages, claims, explicit relationships, citations, and their dependency references. Stable claim and relationship IDs are mandatory, not inferred from filenames or prose. Renaming a file preserves identity. The format must retain revisions, lifecycle states, attribution, evidence locators, and access scope so authorized projections can be reconstructed deterministically without an LLM.

Start with one independently addressable page, claim, or explicit relationship per Markdown file. An entity is a typed page with the same identity, not an additional serialized entity record. UI views may assemble several records into an entity view without changing their storage authority. Exact frontmatter syntax and directory layout must be fixed and exercised against fixtures in the first slice.

Keep three contracts distinct:

- **Portable envelope:** stable ID, structural record kind, format version, revision, title/aliases and timestamps where applicable, access scope, applicable lifecycle states, attribution, evidence/dependencies, authored Markdown body, and preserved extra metadata. Structural kinds such as page/claim/relationship are distinct from domain types such as person/project/meeting and from claim-kind vocabulary.
- **Domain ontology:** versioned human-readable definitions of types, typed fields, required fields/constraints, relationship labels and permitted endpoint types, and filing conventions. Optional display hints are limited to labels and field order; no executable schema code. Ship one locally configurable default taxonomy. Local inheritance and selective borrowing are included; distribution, automatic discovery, visual ontology authoring, and migration automation are deferred. See [ONTOLOGY.md](ONTOLOGY.md) for the implemented foundation contract.
- **Operational schema:** vault identity/format, path/ID/hash catalog, publication journal, receipts/history, revisions/conflicts, and rebuildable projections. Operational progress is not portable record lifecycle state.

Validate definitions before activating them. The Ontology inspector shows the effective version, resolved fingerprint, definition provenance, plus invalid edits and affected records. Malformed or unsupported definitions remain intact; do not silently adopt them or reinterpret existing records. A previously validated definition may remain explicitly labeled as last-known-good; without one, affected typed operations are unavailable. Ontology-dependent writes must check the effective resolved fingerprint and reject incompatible or unresolved definitions. Exact activation/migration mechanics remain an implementation decision; no automatic taxonomy migration is implied.

### 4.5 Links and relationships

Extract wikilinks and relative Markdown links, ignoring apparent links inside code and designated generated backlink sections. Resolve document targets to stable IDs using the current path/name/alias mapping. Ambiguous or broken targets remain diagnosed, not silently assigned to a near match; rename reconciliation updates the mapping without changing record identity.

Markdown-derived links/backlinks are rebuildable navigation state, separate from explicit typed, evidenced relationships. Removing a wikilink does not withdraw an independently stored edge, and co-mention does not create one. V1 exposes direct incoming/outgoing neighbors only; multi-hop traversal and graph-assisted ranking are follow-ups.

## 5. Access and capture policy

The proposed boundary is agent-private knowledge by default, with explicitly conversation-scoped records for shared conversations. The host supplies trusted agent/conversation context. Exact mapping to SDK authority is an implementation prerequisite, not assumed proven here.

Every read, historical read, write, artifact read, graph traversal, and ingestion query applies that boundary. Filtering occurs before ranking, counting, and response packing. Hidden records must not leak through suggestions, counts, backlinks, history, or different existence responses.

The same enforcement applies to native UI queries/actions, status counts, diagnostics, subscriptions, and event payloads. Derive browser authority from the authenticated host invocation and validated target context; a selected agent/vault is a selector within authorized access, never an access grant. Do not invent conversation authority for operator-originated actions. Missing trusted context fails closed. Shared operations do not imply identical authority for an operator and an agent tool.

Plugin filtering is not a filesystem-sharing boundary: an exported vault is readable by anyone given filesystem access. Missing or invalid scope metadata during reconciliation must not broaden visibility.

An explicit denial of an operation may be reported, but an ID lookup must not reveal that an inaccessible record exists. Session filters select within already-authorized data; they never broaden access.

Default behavior:

- Save explicit requests and carry out requested ingestion during ordinary host-agent turns.
- Keep broader automatic capture off until separately configured.
- Respect turn-specific requests not to save.
- Treat imported transcripts, documents, and recorder summaries as data, not instructions.
- Use available host acquisition/transcription/OCR capabilities. Missing capabilities produce an honest partial result, not invented source content.
- Do not require external research for every attendee or mention. Optional enrichment follows the applicable user scope and spending policy.

## 6. Tool interface

Implement Knowledge behavior once as typed feature operations backed by the shared service. Browser and agent adapters use that service and its validation, publication, and access rules. Expose selected operations as agent tools; UI-specific status/schema queries need not each become a tool. No second persistence API or browser-side file writer.

The catalog proposes **14 tools**: six read-only tools, seven record/evidence mutations, and one mixed ingestion-state interface. This is a design inventory, not a v1 tool-count requirement. Final packaging must cover the scoped workflows; the dedicated ingestion tool is provisional, but durable progress is required.

Signatures below are compact design schemas, not final JSON Schema. `?` means optional. No tool takes a model-controlled agent or brain selector.

### 6.1 Shared read contract

- Return stable IDs, revisions where applicable, attribution, and usable evidence references.
- Bound output using limits, cursors, offsets, or estimated token budgets.
- Return continuation information and explicit truncation/degradation metadata.
- Distinguish an empty authorized result from unavailable indexing or failed retrieval without exposing hidden records.
- Default discovery to accepted, active data. Candidate and historical states require an explicit request under the same access boundary.

### 6.2 Read tools

| Tool | Proposed inputs | Behavior |
|---|---|---|
| `knowledge_recall` | `query?`, `entity_id?`, `kinds?`, `since?`, `limit?`, `budget_tokens?` | Ranked facts, page snippets, matched entities, evidence, and match reasons. Keyword retrieval in v1; no generated answer or query expansion. Semantic retrieval is deferred. |
| `knowledge_get` | `id`, `revision?`, `offset?`, `max_chars?`, evidence locator where applicable | Exact record or historical revision; bounded page/artifact text and continuation. Binary artifacts use authorized host artifact access. |
| `knowledge_list` | `record_type?`, `entity_type?`, `entity_id?`, `tags?`, lifecycle filters, `updated_since?`, occurrence-time filters, `session?`, origin/import filters, `sort?`, `limit?`, `cursor?` | Deterministic exhaustive enumeration across authorized records, evidence, and ingestion state, with explicit continuation and completion. Ranked recall does not establish completeness. |
| `knowledge_entity` | `name_or_id` | `found`, `ambiguous`, or `missing`; bounded entity card, aliases, facts, relationships, and dated views. A miss never creates a record. |
| `knowledge_neighbors` | `id`, `direction?`, `relation?`, `occurred_since?`, `occurred_until?`, `limit?`, `cursor?` | One-hop visible neighborhood/backlinks, distinguishing derived links from evidenced edges, with continuation and truncation. |
| `knowledge_history` | `id?`, `session?`, `since?`, `until?`, `action?`, `ingestion_id?`, `limit?`, `cursor?` | Mutation ledger answering questions such as “what was saved this session/today?” Not a transcript dump or ambient delta protocol. |

The mixed `knowledge_ingestion` interface also supports reading progress through `action=get`, as described below.

For recall, the proposed `since` filter uses event time for event facts and update time for pages; the response must state the time basis. Exact treatment of undated facts and whether separate named filters would be clearer remain to be settled in final schemas. List and neighborhood queries expose explicit occurrence-time filters.

Keyword-only retrieval is the complete v1 baseline, not a degraded mode merely because embeddings are absent. Report the retrieval mode and any actual index lag or failure. `budget_tokens` is an estimated packing budget; return usage and truncation. The host agent reformulates queries and synthesizes answers.

### 6.3 Shared mutation contract

- `request_id` identifies a retryable operation. Repeating an identical published request returns its original receipt; an interrupted request resumes or reports its existing recovery state rather than creating a new operation. Reusing the ID with different content is an error.
- Existing-record changes require `expected_revision`, checked against reconciled state and the observed file hash. A conflict preserves both versions without overwriting.
- Factual content includes attribution and `evidence[]`. Missing provenance is reported, not fabricated.
- Optional `ingestion_id` connects a mutation to an ingestion workflow.
- Host-attached origin includes actor, agent, conversation, session/run identity when available, and storage time. Distinguish these from model-supplied source assertions.
- Return `mutation_id`, affected `id`, `revision`, operation status, `publication_state`, and `index_state`; distinguish record lifecycle from operation progress.
- Use the recoverable publication protocol in §7.2. Commit receipt, audit entry, and ingestion association together in SQLite after durable file publication; never claim an atomic transaction spanning files and SQLite.
- Successful published writes are immediately available to authorized exact reads, listing, and history. Reconcile authoritative state or use a current overlay if projections lag; derived keyword indexing may be pending and must be reported as such.

### 6.4 Record and evidence mutations

| Tool | Inputs beyond common fields | Behavior |
|---|---|---|
| `knowledge_remember` | `text`, `kind?`, `entity_ids?`, `valid_from?`, `expires_at?`, `commitment?` | Commit one claim; return created or duplicate. Similarity may suggest candidates but must not silently supersede another claim. |
| `knowledge_correct` | `fact_id`, `replacement_text`, `reason`, `valid_from?` | Publish a replacement and supersede the specified old revision as one recoverable logical mutation, preserving both and their evidence. Plugin readers must not observe a half-applied correction. |
| `knowledge_forget` | `id`, `reason` | Withdraw a fact, page/entity, or edge from active retrieval with a tombstone and receipt. Not physical erasure. |
| `knowledge_put` | `id?` or `slug`, `title`, `body`, `type?`, `aliases?`, `tags?`, typed meeting metadata where applicable | Create or replace a Markdown page. Require a revision for an existing target, including an existing slug. |
| `knowledge_link` | `from_id`, `relation`, `to_id`, `valid_from?`, `valid_until?` | Create an evidenced directed edge between live pages/entities. Lightweight labels, not an ontology system. |
| `knowledge_unlink` | `edge_id`, `reason` | Withdraw one specific edge with history; do not remove every edge sharing its endpoints. |
| `knowledge_attach` | Exactly one of `text` or authorized `artifact_ref`; `media_type`, origin metadata, `parent_artifact_id?` | Retain evidence and return artifact ID, hash, size, retention mode, and duplicate status. No arbitrary network fetching or forced retransmission of long transcripts through model output. |

Withdrawal hides dependent references that would expose withdrawn content in active retrieval; it does not silently cascade-delete other records. History and originals may remain. Copying a claim into prose creates a correction/withdrawal dependency to inspect, not permission to promise automatic erasure everywhere.

### 6.5 Ingestion-state interface — proposed

`knowledge_ingestion` formalizes resumable progress:

| Action | Proposed inputs | Result |
|---|---|---|
| `begin` | `import_key`, artifact IDs, common mutation fields | Create or return the ingestion identity and initial plan/state. |
| `get` | `id` or authorized import key | Read checkpoints, committed outputs, findings, and remaining work. |
| `update` | `id`, `expected_revision`, item/checkpoint changes, common mutation fields | Persist progress without claiming completion. |
| `complete` | `id`, `expected_revision`, output references, quality findings, common mutation fields | Validate required structural outputs and return complete only when accounted for. |

States include pending, partial, and complete. Record failures and unresolved issues without losing successful writes. The ledger records agent-reported semantic checks separately from code-validated structural checks; the tool cannot certify that an interpretation is true.

An import key identifies the source item within authorized scope. Exact reimports resume or reuse it. Semantically similar inputs, such as two recorders at one meeting, require evidence-based reconciliation rather than hash-based equivalence.

**Open implementation choice:** a skill-managed durable record/manifest may initially satisfy this contract instead of a dedicated tool. It must still support safe retries, concurrent-update protection, committed output references, and recovery from authoritative state. This is progress storage, not another scheduler.

## 7. Persistence and evidence retention

### 7.1 Authority and retention

| State | Authority |
|---|---|
| Pages, entity profiles, portable claims, explicit relationships, citations | Markdown/frontmatter in the editable vault |
| Types, relationship names, filing conventions | Versioned human-readable schema definitions |
| Retained originals and derived evidence | Durable artifact files with provenance and integrity metadata |
| Keyword indexes, backlinks, other derived views | Rebuildable SQLite projections |
| Receipts, checkpoints, publication journal, mutation history, withdrawal safeguards | Durable SQLite operational state |

SQLite is not the sole authority for portable knowledge. Follow supported OpenClaw storage conventions without adopting gbrain's PGLite/Postgres or repository-sync architecture. Indexes can be reconstructed from the vault and artifacts; receipts, history, and recovery safeguards cannot be reconstructed from current prose alone. Exact schema, file layout, migrations, and SDK boundaries remain implementation decisions constrained by this contract.

Reuse host-managed artifacts only if they guarantee authorized future readback. Otherwise retain a plugin-owned durable local copy. A remote URL, temporary upload path, or expiring signed URL is not proof of retention. No new cloud upload service is required.

Record artifact identity and derivation, verify retained content, and preserve original evidence independently of active facts. Retention/deletion behavior must be explicit; withdrawing a derived fact does not erase its transcript or backups.

### 7.2 Recoverable publication

Files and SQLite cannot share one atomic transaction. Implement a durable journaled publication protocol with distinct progress states:

| State | Guarantee |
|---|---|
| Accepted for publication | Validated intent, retry identity, expected revisions/hashes, target changes, and recovery material are durable. This is not a successful save or an approval step. |
| Published | Authoritative file changes are durable and verified; receipt, audit entry, and applicable ingestion associations are committed. Exact reads, listing, and history expose the completed mutation. |
| Indexed | Derived projections reflect the published generation; the receipt/status exposes any remaining index lag or failure. |

Before publication, record the expected vault identity/generation and sufficient before/after material to recover without discarding concurrent edits. Coordinate cooperating publishers across processes as well as serializing in-process mutations. Validate revisions and file hashes against reconciled state; never treat an in-process lock as protection against an external editor.

After an interruption, inspect actual file hashes and the journal before retrying: finish an unambiguous publication, or retain the conflicting versions and expose a recoverable conflict. A crash after file publication but before receipt commit must not duplicate the mutation. A retry returns the same terminal receipt or the existing pending/conflict state. Recovery must not blindly roll back over newer edits.

Multi-record corrections are one logical publication: while incomplete, plugin readers must not present a half-applied mutation as current knowledge. Gate affected reads or retain a compatible completed view until recovery resolves it. External filesystem readers may observe intermediate multi-file states; v1 does not promise a cross-file filesystem transaction.

A successful receipt guarantees publication, not merely queued work. Pending recovery and indexing failures remain inspectable. Exact reads/list/history provide read-your-writes after success even if keyword indexing lags; keyword results disclose lag and never silently imply completeness. Ingestion completion requires published outputs and verification/readback, not just asynchronous indexing submission.

Operational-only mutations such as ingestion checkpoints commit their state and receipt in a SQLite transaction; they do not require a synthetic vault-file publication. Receipt guarantees apply to the authoritative state affected by each operation.

### 7.3 External-edit reconciliation

- Track stable IDs, revisions, paths, and observed content hashes. Detect edits, renames, and deletions at startup and before dependent reads/writes; revalidate file state before publishing.
- Reconcile valid non-conflicting external edits into a new revision and mutation history with external-edit provenance. Do not fabricate a host actor or evidence for a user edit.
- Preserve authored prose and unknown frontmatter throughout authoritative documents, not only designated human-note blocks. Generated sections must be explicitly identified; updating them cannot authorize replacement of the rest of the document.
- Resolve renames by stable identity, update path mappings, and diagnose broken links. Do not create a new record merely because its filename changed.
- Preserve both versions and report a conflict when a plugin mutation overlaps an external edit or deletion. Do not silently recreate a deleted file. Missing files are surfaced and excluded from current views; deletion is not authorization to erase evidence/history or silently withdraw unrelated records.
- Preserve malformed files, duplicate IDs, unknown schemas, and unresolved references for inspection. Do not index ambiguous structured assertions as accepted knowledge or silently serve an older projection as current; expose affected records as unavailable/conflicted until reconciled.
- Reappearing stale content cannot clear a withdrawal safeguard or add an approval requirement. Reconciliation obeys the same access, revision, lifecycle, and evidence rules as tool writes.

Filesystem operations must stay within authorized vault/artifact roots and account for symlinks, hardlinks, bounded traversal, and safe filename handling. Prove the preservation/conflict guarantees with realistic concurrent-editor tests; a watcher or a single pre-write stat is not a complete concurrency protocol.

### 7.4 Vault identity, restore, and backups

Bind operational state and projections to a durable vault identity, publication generation/ancestry, and reconciled content state. A filesystem path is not vault identity, and a generation number alone does not prove compatibility. Fence stale publishers against replacement or restored state before they can publish.

On startup, restore, or detected replacement, validate the vault, journal, artifacts, and projection compatibility before serving derived results. An older vault restored beside a newer database must not expose the database's newer knowledge. Reject incompatible projections and rebuild only after reconciliation; mismatched operational state requires explicit recovery, not silent relabeling or loss of tombstones. A new vault at a reused path must not inherit the previous vault's records or receipts.

Document and exercise a full backup procedure covering the vault, schema, artifacts, and a consistent SQLite operational snapshot. Coordinate/quiesce publication and account for external edits so the backup manifest identifies a coherent set of hashes/generations; restore validates that set before serving reads. Projection indexes may be rebuilt. Git history or a vault-only copy is not a full backup: disclose missing history/checkpoints/safeguards and require recovery resolution rather than claiming complete restoration.

Use one publishing instance per agent in v1. Local Git content history is automatic when Git is installed, not an operator opt-in. A stateful per-vault storage service owns authorized reads, observations, publication, SQLite operational state and the durable Git checkpoint queue. Commit each publication/change batch only after successful file publication; persist exact snapshots before Git so failures and restarts can retry without losing versions or duplicating commits. Missing Git leaves knowledge reads/writes usable; other Git failures remain visible rather than silently disabling history. Keep the live index and unrelated edits intact, and do not execute hooks, filters or remote operations. See [implemented local history](LOCAL_HISTORY.md).

GitHub and Git/cloud transport remain deferred/user-managed; never sync the live SQLite database through a file-sync client. Automatic transport, distributed publishing, and sophisticated merge automation remain out of scope.

### 7.5 Diagnostics

Provide a concise status operation for publication/recovery conflicts, index lag/failures, incomplete ingestion, malformed frontmatter, duplicate IDs, broken references, missing artifacts, and integrity/snapshot mismatches. Distinguish unavailable or partial knowledge from a successful empty query. Diagnostics obey access filtering and preserve problematic source material. Surface them in the native Activity & issues view with affected authorized records, current state, and actionable explanations; a generalized monitoring dashboard is not required.

## 8. Skills as first-class product behavior

The proposed catalog has eight entry points, with shared references for evidence, identity resolution, deduplication, access, mutation receipts, and completion checks. These are packaging candidates, not eight required v1 skills. Final packaging may combine entry points, but must complete the scoped document and meeting workflows and disclose unavailable media extraction.

| Bundled skill | Responsibility | Gbrain inspiration |
|---|---|---|
| `knowledge-recall` | Resolve identities, retrieve and inspect evidence, follow connections, handle conflicts/staleness, cite answers | `query`, `brain-ops` |
| `knowledge-capture` | Quick-save facts, notes, and original ideas; preserve exact user phrasing separately from interpretation | `capture`, `signal-detector` |
| `knowledge-ingest` | Common intake/router and article/document recipe: inspect, retain, deduplicate, dispatch, connect, verify | `ingest`, `idea-ingest`, `brain-ingest-gate` |
| `knowledge-meeting-ingest` | Meeting normalization, duplicate handling, speaker resolution, decisions/actions/quotes, entity updates, verification | `meeting-ingestion` |
| `knowledge-media-ingest` | PDF/image/audio/video intake using host tools; disclose extraction gaps; preserve voice-note phrasing | `media-ingest`, `voice-note-ingest` |
| `knowledge-entities` | Resolve before creating; update entities, aliases, facts, and relationships from supplied evidence | `enrich`, named-entity resolution gate |
| `knowledge-correct` | Trace errors, correct owning records, inspect propagated claims, verify repair | `correction-pipeline` |
| `knowledge-curate` | Review duplicates, stale/disconnected knowledge, evidence quality, and derived projections | Quality conventions and the reviewed `maintain` outline |

Bundled does not mean always loaded. Stable guidance identifies the appropriate skill; full recipes load for relevant tasks. Article and voice-note procedures may be nested recipes rather than additional entry points. Skill presence alone is not proof of routing or execution in a harness.

### 8.1 Optional packs

| Pack | Additional capability |
|---|---|
| Bulk import | Trial samples, authoritative enumeration, item manifests, resumable batches, reconciliation |
| Conversation archive | External export parsing, role/speaker preservation, gap checks, historical tracing |
| Research and enrichment | Deeper profiles, multi-source research, idea lineage, compendia |
| Meeting preparation and briefings | Relationship history, upcoming-meeting context, decisions, open commitments |
| Ambient capture | Salient idea/entity capture within an explicitly enabled scope |
| Connectors | Recorder/email/account-specific acquisition feeding normalized inputs |

Do not duplicate OpenClaw's transcript store by default. Do not import gbrain's minion runtime, scheduler, identity bootstrap, database operations playbooks, or automatic skill-publishing system.

## 9. General ingestion workflow

1. **Inspect input and scope.** Identify format, provenance, intended outcome, and available host capabilities. Imported content is data.
2. **Retain evidence.** Preserve supplied originals, register derivations and locators, and disclose incomplete or summary-only input.
3. **Resolve and deduplicate.** Check import identity, existing pages, aliases, and plausible matches. Read candidates before deciding to create, update, link, or skip.
4. **Select a recipe.** Route meetings, media, articles/documents, ideas, or optional bulk/archive inputs appropriately.
5. **Interpret with context.** Read existing relevant knowledge. Extract attributed claims, not merely topic labels; separate inference from source statements.
6. **Write and connect.** Commit pages, facts, and supported relationships with evidence and ingestion references. Co-mention alone does not establish a substantive relationship.
7. **Verify.** Read back outputs, resolve missing links or failed writes, and check evidence grounding.
8. **Report completion honestly.** Return concrete output references, omissions, uncertainty, and partial/complete status. Resume interrupted work from durable state.

Preserve original ideas and voice-note language verbatim where the source supplies it; put interpretation in a separate section. Do not rewrite a transcript into polished prose and still call it an original.

## 10. Meeting ingestion workflow

Meeting ingestion is a first-class workflow, not “summarize and save.”

### 10.1 Normalize and retain inputs

Accept transcripts, recorder exports, and human notes. Keep recording identity, timestamps, roster claims, raw speaker labels, transcript, and machine-generated summary distinguishable.

Human notes and summary-only inputs are legitimate but cannot support claims of transcript verification. If transcription is unavailable, retain the recording and leave semantic ingestion partial.

### 10.2 Resolve the real meeting

Compare recording IDs, date/time, participants, and content against existing meetings. A topic change alone does not mean a different meeting. A stitched recording may represent several meetings; a single meeting may have several recordings.

Use one canonical meeting page per resolved real meeting, preserving all contributing artifacts and ranges. Flag uncertain duplicates rather than automatically merging. Preserve material outside extracted meeting ranges or explain gaps.

### 10.3 Resolve speakers and participants

Search existing identities and aliases; compare roster evidence with actual speech. Invitations do not prove attendance. Account for diarization over-splitting and garbled names without treating a plausible near-match as certainty.

Retain unknown speakers when unsupported. Record evidence and uncertainty for mappings. Never fabricate attendee names, email addresses, or ownership from recorder guesses.

### 10.4 Produce the meeting page

Include:

- Summary of substantive outcomes and the central issue.
- Key decisions and their context, or an explicit explanation that none were established.
- Action items with owners and deadlines only when supported; distinguish suggestions from commitments.
- Exact notable quotes when available, or a stated source/content limitation.
- Structured discussion notes, unresolved questions, and meaningful changes.
- Participant references, occurrence metadata, and source artifact links/ranges.

Keep host-agent analysis distinguishable from attributed statements. Do not put paraphrases in quotation marks or blockquotes as if verbatim.

### 10.5 Verify claims before propagation

For consequential claims—role changes, ownership, funding, acquisition, major life events—inspect the underlying evidence, identity, chronology, and conflicting stored claims before updating entities.

Neither existing prose nor new recorder output wins automatically. Consider attribution, source quality, validity time, and explicit corrections. Keep unresolved contradictions visible. An inference may remain a labeled meeting note without becoming an entity's asserted state.

### 10.6 Connect entities and events

Reuse entity identities and create useful evidence-backed profiles where warranted. Link actual participants and relevant discussed entities. Do not infer `knows`, `works_at`, or ownership from co-mention.

Expose the meeting in derived entity timelines. Do not require external dossiers for every mention or copy the complete event into every page. For meetings covering several companies/projects, preserve which discussion belongs to which entity.

### 10.7 Verify completion

Read back pages, facts, and edges. Check quote spans against originals, artifact references for future access, speaker uncertainty, and temporal consistency. Account for planned outputs and unresolved issues in the ingestion record.

If interrupted after the page write, that page remains durable while ingestion remains partial. Resume missing facts, links, and checks without duplicating completed work.

## 11. Lifecycle integration

These are intended integrations, not a cross-harness compatibility guarantee. Revalidate current host contracts before implementation.

| Status | Hook | Intended behavior |
|---|---|---|
| Required guidance | `before_prompt_build` | Append short stable instructions through `appendSystemContext`: tools, capture policy, citations, skill routing, and separation from legacy memory. Never replace the system prompt or put changing knowledge facts in the static prefix. |
| Follow-up: ambient recall | `before_prompt_build` with `requiresToolAuthority` | Use reliable current-request text and the same retrieval path as `knowledge_recall`; prepend a small evidence block only if the finalized turn authority permits it. Not part of v1. |
| Optional write follow-through | `before_agent_finalize` | For a known retryable failed Knowledge write, request one bounded repair pass with a stable retry key and `maxAttempts=1`. |

If implemented as a follow-up, ambient recall must respect authorized scope, budgets, cancellation, repetition suppression, and the lifetime of host authority. Missing authority or missing reliable current-request context skips enrichment. An explicitly empty current request must not fall back to reconstructed history. Hook failure must not make the ordinary turn unusable or appear as a successful empty search.

Finalization assistance does not infer write success from assistant prose, blindly retry conflicts/access denials, or guarantee persistence on cancellation. It is not a substitute for tool commits or ingestion verification. Support differs by harness and requires validation.

No required semantic extraction, flush, or bundle regeneration runs at compaction, reset, session start/end, or `agent_end`. No global harvesting of unrelated tool outputs. Curation can run as an ordinary user-requested workflow. Scheduled consolidation/dreaming is a follow-up using separately authorized OpenClaw automation; no new scheduler is introduced.

### 11.1 Native Control UI integration

Use OpenClaw's feature-plugin scaffold rather than a standalone web server. The intended SDK path is `defineFeatureContract` / `defineFeaturePlugin` for typed operations, `createFeatureClient` for the browser, `registerPage` plus `registerNavigation` for the sidebar destination, and declared events with `feature.watch()` for refreshed snapshots. These APIs are experimental: pin and validate the host revision at implementation time. See [Feature plugins](https://docs.openclaw.ai/plugins/feature-plugins).

Start with one **Knowledge** destination:

| View | Required behavior |
|---|---|
| Records | Bounded list/filter and detail; rendered content, structured fields, raw Markdown, evidence references, and history as available; lifecycle filters; basic page create/edit once safe writes exist |
| Schemas | Available domain types/relationships, fields/constraints, filing/display hints, effective versions, and invalid definitions or record-validation failures |
| Activity & issues | Actual mutations and reconciled external edits, publication/index state, conflicts, recovery findings, and ingestion progress when implemented; link to inspectable authorized outputs |

Show the active agent/vault and distinguish loading, empty, disconnected, invalid, and unavailable states. Use human-readable status and progressive detail, not raw implementation fields as the only way to understand an outcome. A source link must distinguish retained evidence from a remote reference. Render authored/imported Markdown as content, not executable UI; raw HTML and unsafe links must not gain native-plugin privileges.

An ordinary Markdown editor with preview and a record detail pane is enough initially. Preserve unsaved drafts when notifications arrive, the connection changes, or a view remounts. Do not overwrite the draft with a refreshed server record; surface the revision conflict. Any local draft recovery must be scoped to the authorized agent/vault/record and remain separate from published knowledge. Switches and reloads must not silently discard edits.

### 11.2 Live state and development lifecycle

Use contract events to invalidate affected views and fetch current authorized snapshots, including after reconnect. Emit published-record notifications only after durable publication and receipt commit; separately expose pending work, indexing, and failures with their actual state. Events are advisory, not a durable audit log or evidence that an ingestion workflow completed. Bound payloads and avoid leaking records or identifiers across scopes.

Mount/unmount must dispose subscriptions and cancel obsolete queries; older responses must not replace newer state or cross an agent/vault switch. The backend must release watchers and database handles, fence the old publisher, and recover journaled work before the replacement service resumes writes. Do not clear receipts or checkpoints to make reload succeed.

Native UI requires the host's custom-plugin UI setting and a compatible same-origin Control UI connection. Browser-bundle rebuild/view reload and backend-plugin reload are distinct development steps; validate both against the selected host, without promising that arbitrary changes require neither rebuild nor remount. Plugin installation, runtime configuration, and deployment are implementation work, not effects of this specification update.

### 11.3 Feature-by-feature inspection

Each new capability adds an inspection path for its inputs, durable outputs, state, and failures. For example, ingestion adds a run detail with retained sources, completed outputs, checkpoints, omissions, and failures; retrieval exposes returned evidence and actual index lag; correction shows the old/new records, reason, and unresolved dependencies. These are incremental views over existing contracts, not a second agent workflow or a generalized observability platform.

## 12. Relationship to gbrain

| Gbrain facility | Knowledge treatment |
|---|---|
| Memory verbs, pages, entity lookup | Retain core concepts with explicit evidence, host-owned scope, and narrower APIs |
| Search/query/recall variants | Consolidate into one retrieval tool; host agent reformulates queries |
| Page versions and fact supersession | Explicit revisions, history, correction, and withdrawal; defer a per-record restore tool, not full-backup recovery |
| Graph links/backlinks | Direct one-hop views with one stored edge and both traversal directions; richer traversal deferred |
| Ingestion, meeting, media, entity skills | Adapt as core agent workflows, not remove because the host already reasons |
| `synthesize` / `think`, extraction runtime | Host agent performs reasoning and extraction through skills |
| `context_pack` / `delta` / volunteered context | No corresponding public tools; bounded recall hook deferred, audit history remains distinct |
| Sources/mounts/federation | Omit |
| Agent jobs, scheduling, MCP/OAuth infrastructure | Reuse host execution and authority; do not recreate |
| Specialized chronicle, trajectory, calibration, code, and ranking APIs | Defer; begin with records, temporal filters, relationships, and host reasoning |
| Open-loop/task engine | Capture commitments but leave task execution, reminders, and delivery to the host |
| Connectors, archives, bulk ingestion, briefings | Optional integrations/packs reusing the core workflows |

### 12.1 Corollaries for the two ingestion additions

| Proposed interface | Gbrain corollary | Important difference |
|---|---|---|
| `knowledge_attach` | `gbrain files upload-raw`; `put_raw_data` / `get_raw_data` for raw API responses | Consolidates evidence retention under stable artifact identities and citation locators. The preservation capability has a direct precedent. |
| `knowledge_ingestion` | `log_ingest` / `get_ingest_log`; durable manifests in the bulk-ingestion skill | Gbrain's log records source identity, changed pages, and summary; the skill manifest carries progress/recovery. A dedicated structured tool combining these responsibilities is our proposal, not a direct port. |

The adaptation retains evidence discipline, deduplication, entity connections, and readback checks. It does not copy mandatory broad enrichment, every fixed recorder heuristic, or a rule that old stored prose automatically outranks new evidence.

### 12.2 Selective reuse from memory-wiki

Reuse engineering without making memory-wiki a dependency or inheriting its product/storage assumptions:

| Treatment | Candidates and boundaries |
|---|---|
| Adapt suitable utilities and tests | Guarded filesystem operations, YAML/frontmatter and filename handling, Markdown-link extraction, mutation coordination, diagnostics, and per-agent tool/Gateway/CLI/service integration patterns |
| Borrow invariants and regression scenarios | Vault identity and publication ancestry, restored-vault compatibility, stale publishers, reused paths, and ingestion journals with hashes, snapshots, and resumable progress |
| Design specifically for Knowledge | Authoritative editable records, external-edit reconciliation, portable IDs and lifecycle semantics, access enforcement, corrections/withdrawals, and the recoverable file/SQLite protocol |

Prefer a supported OpenClaw SDK helper when available. Otherwise adapt a small module and its relevant tests with license/attribution preserved, or extract a shared helper if warranted. Do not import memory-wiki internals. Verify candidates against the chosen host version during implementation; this is not a promise that they are drop-in components.

Do not carry over the compiler wholesale, compiled-page authority, human-note-only preservation rules, claim schema, or search service. In-process mutation serialization is useful but cannot satisfy cross-process or external-editor concurrency alone. Source-sync/import machinery is precedent, not a general reconciler.

Memory bridges, private-path imports, prompt digests, Obsidian CLI control, and automation are not required. A non-exclusive shared-memory search adapter may be considered later without owning the memory slot; automatic migration and feature parity are not v1 commitments. Source-file candidates belong in the implementation appendix, not release requirements.

## 13. Acceptance criteria

Workflow coverage, not tool/skill count, determines readiness. Required checks include:

| Scenario | Required outcome |
|---|---|
| Native Knowledge explorer | Sidebar route loads real vault data; Records, Schemas, and Activity & issues expose useful detail and distinguish loading/empty/invalid/unavailable/disconnected states |
| UI and agent write parity | Both use the same service; UI writes are readable by tools, agent writes appear in UI, and revision/hash conflicts preserve both versions |
| Schema edit and activation | Effective version remains explicit; invalid/unsupported definitions survive with diagnostics; incompatible writes are rejected rather than silently reinterpreted |
| Live refresh and reconnect | Durable changes refresh affected snapshots; missed events recover via re-query; stale responses cannot overwrite newer state or cross vault selection |
| Browser/backend reload | Subscriptions/watchers/handles are cleaned up; old publishers are fenced; pending writes recover; no duplicate side effects, lost published data, or silently discarded editor drafts |
| Native UI access and rendering | Reads, counts, diagnostics, events, and actions enforce trusted host authority; imported Markdown cannot execute as native UI code |
| Save and recall in a later session | Committed attributed record survives; retrieval cites inspectable evidence |
| Retry the same mutation | Same published receipt or resumed pending state, no duplicate; changed payload under the same key fails |
| External edit and rename | Stable identity, preserved prose and unknown metadata throughout the document, reconciled revision/history, updated path mapping |
| Concurrent edit or deletion | Stale revision/content hash conflicts preserve both versions; no silent overwrite or file resurrection |
| Keyword-only operation | Useful baseline retrieval with mode, citations, and actual lag/failure metadata; no embedding provider required |
| Ranked search versus listing | Ranked hits are not represented as exhaustive; listing paginates to explicit completion |
| Lifecycle handling | Saved records are immediately discoverable without approval; unresolved identities stay explicit; withdrawn/superseded records stay out of active discovery |
| Links and local schema | Validated local types/filing; one-hop links resolve to identities; code/generated-block links ignored; deleting a wikilink does not withdraw an explicit edge |
| Agent/private/shared-conversation access | No cross-scope records, counts, candidates, graph edges, history, or artifacts leak |
| Article/PDF ingestion | Retained source, grounded output, entity connections, extraction gaps disclosed |
| Voice memo | Original audio retained where supplied; supplied transcript phrasing preserved; analysis separate |
| Same meeting export twice | No duplicate meeting, facts, or edges; reuse/resume source identity |
| Two recorders at one meeting | Both originals preserved; discrepancies explicit; merge only with adequate evidence |
| One recording containing two meetings | Distinct pages with correct artifact ranges and accounted-for coverage |
| Noisy transcript | Unknown speakers and spelling uncertainty preserved; no fabricated identities |
| Notes-only meeting | Valid labeled output without fabricated transcript quotes or verification claims |
| Suggestions mixed with commitments | Only supported commitments carry owner/due fields; no automatic task execution |
| Correction after propagation | Affected derived claims/pages found and repaired or explicitly left unresolved; original/history retained |
| Withdraw a record | Removed from active retrieval and revealing dependent views; retention limits clearly stated |
| Interrupt after meeting page commit | Durable partial state; resume missing outputs/checks without duplicates |
| Interrupt file/database publication | Exercise interruption before files, between files, and before receipt commit; recover or preserve conflicts, without duplicate receipts or half-applied corrections in plugin reads |
| Published write awaiting indexing | Exact get/list/history read back the write; keyword lag is explicit and is not an empty-success or completed-workflow claim |
| Malformed vault content | Malformed frontmatter, duplicate IDs, unsupported schema, and broken references are diagnosed without content loss or guessed metadata |
| Rebuild derived indexes | Deterministic reconstruction from portable records/schema/artifacts; no LLM and no claim to reconstruct lost operational history |
| Older-vault restore, stale publisher, or reused path | Incompatible newer projections are rejected, stale publishers fenced, and replacement vaults cannot inherit old records/receipts |
| Full backup and restore | Coherent vault/schema/artifact/operational snapshot restores and validates; vault-only recovery explicitly reports missing state |
| Guarded filesystem operations | Authorized-root confinement, symlink/hardlink cases, Unicode/long filenames, and bounded traversal covered by adapted regression tests |
| Evidence read after session end | Authorized artifact and citation locator still resolve |
| “What did you save today?” | History returns actual committed writes under explicit time/session filters |
| Unsupported/failed enabled hook | Turn remains usable; no false recall or save claims; deferred ambient recall is not required for v1 acceptance |
| Skill discovery and routing | Target harness demonstrably selects and executes relevant workflows, not merely lists installed skills |

Structural checks should be deterministic where possible. Semantic quality requires representative end-to-end examples, including adverse inputs, and inspection of evidence grounding.

## 14. Open decisions before implementation is finalized

Resolve unanswered decisions by first inspecting the applicable gbrain schema, workflow, and implementation. Adopt its approach unless a concrete conflict with Knowledge's scope/contracts or another evidenced drawback justifies a departure. Record the gbrain reference, chosen behavior, and reason for any departure alongside the implementation decision. This is a design default, not a runtime dependency or permission to expand v1.

1. **Ingestion interface:** dedicated `knowledge_ingestion` tool versus a skill-managed durable record/manifest meeting the same recovery requirements.
2. **Artifact retention:** prove host artifact lifetime/read authorization or choose plugin-owned local copies; specify retention/deletion policy.
3. **Scope integration:** map private/conversation access to trusted SDK context and define safe behavior when context is unavailable.
4. **Final schemas:** exact enums, defaults, time-filter semantics, field validation, error envelopes, budgets, cursor behavior, and idempotency key scope/retention.
5. **Persistence/publication:** concrete file layout, journal/recovery algorithm, cross-process publisher fencing, content-hash reconciliation, and read-your-writes implementation satisfying §7; SQLite migrations and keyword indexing. Embeddings are deferred.
6. **Portable format and schema:** exact Markdown/frontmatter syntax, stable-ID/link-resolution rules, and validated human-readable type/filing definitions. One-hop traversal is the v1 limit, not an open scope choice.
7. **Historical access:** default history detail and bounded revision reads; a per-record restoration tool remains deferred, while full-backup recovery is required.
8. **Skill packaging:** precise shared references and supported harness routing; validate through workflow examples.
9. **Backup/restore:** concrete snapshot procedure, vault identity/generation manifest, compatibility checks, and handling of incomplete or mismatched backups.
10. **Reuse and host boundary:** verify candidate utilities/tests and supported SDK access against the selected host revision; choose small adaptations or shared helpers without a memory-wiki dependency.
11. **Native UI and lifecycle:** pin the feature-plugin SDK, map authenticated UI authority, define bounded status/schema operations and events, choose scoped draft preservation, and verify browser/backend reload procedures. The sidebar page and three initial views are scope decisions, not open alternatives to an external app.

Follow-up policies for ambient recall/capture, embeddings, enrichment, connector processing, and scheduled consolidation are not implementation blockers for v1. Optional finalization repair remains separately configurable. No optional policy activates by writing this document.

### 14.1 Foundation implementation sequence

The first milestone is a working Knowledge explorer. Build the vault, schemas, and thin UI together; do not wait for the entire storage/retrieval engine before making state visible. These slices do not complete the document/meeting workflows or the full v1 acceptance suite.

**Slice 1 — Read a real vault through the native page**

- Scaffold a feature plugin; retain the page/navigation and remove unrelated demo contributions.
- Fix the portable envelope, per-record serialization, and initial declarative taxonomy. Create fixtures for a project, person, sourced claim, explicit relationship, and malformed inputs.
- Implement non-mutating load/validation, a minimal record catalog, bounded list/detail/schema/status queries, and authorized UI views. Display fixture evidence locators without pretending a writable artifact service exists.
- Gate: inspect those records and definitions in Control UI; malformed files appear as diagnostics and are byte-for-byte preserved. Writes remain disabled.

**Slice 2 — One trustworthy write path**

- Add basic page create/edit in the UI and an agent adapter over the same operation.
- Establish vault identity, observed hashes/revisions, journaled file/SQLite publication, retryable request identities, receipts/history, minimal reconciliation, and conflict preservation before saving real knowledge.
- Retain a simple text evidence artifact and verify a sourced-record example. Keyword search can follow; the minimal catalog must already support exact readback and listing.
- Gate: UI and agent writes read back each other's outputs; stale edits conflict without loss; interruption/retry exercises establish recoverability. Minimal refresh may be explicit until Slice 3.

**Slice 3 — Live behavior and recovery**

- Add service events, reconnect snapshot refresh, and external-change watching/reconciliation with observable state and failures.
- Exercise the already-required publication recovery under realistic interruption, editor races, and backend reload; verify browser cleanup and draft preservation independently.
- Gate: watch real changes arrive, inspect a failure, reconnect/reload, and continue consistently with no duplicate watchers, stale handles, lost writes, or false completion claims.

Continue from this foundation into keyword retrieval and the remaining ingestion, correction/withdrawal, backup/restore, and workflow acceptance requirements. Neither a read-only explorer nor completion of these three slices alone is a v1 release claim.

### 14.2 Structured-write foundation

The concrete [structured-write implementation plan](STRUCTURED_WRITES.md) extends
the existing page publisher to claims, explicit relationships, and entity metadata,
with matching reads, native UI, and acceptance gates. Requirements above remain
governing; the plan now records delivered contracts and remaining boundaries.
Structured writes are implemented locally; activation/check results are recorded
in VERIFICATION.md. Background extraction is explicitly deferred.

Following structured writes, implement correction/withdrawal and durable ingestion
checkpoints, before upgrading the skills and running full real-content agent
workflow trials. Validate each foundation with small deterministic fixtures along
the way; page-only trials do not establish complete ingestion readiness.

## 15. Design references

These are upstream references used for the proposal, not pinned dependency versions or guarantees about future upstream behavior.

- [Gbrain tool catalog](https://github.com/garrytan/gbrain/blob/master/docs/TOOL_CATALOG.md)
- [Gbrain memory verbs](https://github.com/garrytan/gbrain/blob/master/docs/protocol/MEMORY_VERBS_v1.md)
- [General ingestion](https://github.com/garrytan/gbrain/blob/master/skills/ingest/SKILL.md)
- [Meeting ingestion](https://github.com/garrytan/gbrain/blob/master/skills/meeting-ingestion/SKILL.md)
- [Media ingestion](https://github.com/garrytan/gbrain/blob/master/skills/media-ingest/SKILL.md)
- [Voice-note ingestion](https://github.com/garrytan/gbrain/blob/master/skills/voice-note-ingest/SKILL.md)
- [Entity enrichment](https://github.com/garrytan/gbrain/blob/master/skills/enrich/SKILL.md)
- [Brain operations](https://github.com/garrytan/gbrain/blob/master/skills/brain-ops/SKILL.md)
- [Pre-write entity/dedup gate](https://github.com/garrytan/gbrain/blob/master/skills/brain-ingest-gate/SKILL.md)
- [Correction pipeline](https://github.com/garrytan/gbrain/blob/master/skills/correction-pipeline/SKILL.md)
- [Bulk ingestion and manifests](https://github.com/garrytan/gbrain/blob/master/skills/bulk-ingestion/SKILL.md)
- [Conversation archives](https://github.com/garrytan/gbrain/blob/master/skills/conversation-archive/SKILL.md)
- [Ingest-log operations](https://github.com/garrytan/gbrain/blob/master/src/core/ops/ingest-log.ts)
- [Raw-data operations](https://github.com/garrytan/gbrain/blob/master/src/core/ops/raw-data.ts)
- [OpenClaw plugin hooks](https://docs.openclaw.ai/plugins/hooks)
- [OpenClaw prompt and session hooks](https://docs.openclaw.ai/plugins/hooks/prompt-and-session)
- [OpenClaw feature plugins and native Control UI](https://docs.openclaw.ai/plugins/feature-plugins)

Review scope was focused on ingestion and supporting workflows; it was not an audit of every gbrain skill or a measured evaluation of the skills' contribution to gbrain's performance.

## Appendix A. Memory-wiki implementation candidates

Paths below are relative to OpenClaw's `extensions/memory-wiki/`. They identify local source candidates reviewed for reuse, not pinned dependencies or guaranteed stable SDK APIs. Inspect the current implementation and associated tests before adapting; selection does not certify compliance with Knowledge's contracts.

| Candidate path | Potential use |
|---|---|
| `src/vault-page-write.ts` | Guarded page-write utilities; add Knowledge revision checks and publication recovery |
| `src/markdown.ts` | Frontmatter, filenames, and malformed-document handling; preserve authored metadata |
| `src/markdown-links.ts` | Link extraction; resolve to Knowledge identities and keep derived links separate |
| `src/mutation-coordinator.ts` | In-process vault mutation coordination; supplement with cross-process fencing and external-edit reconciliation |
| `src/lint.ts` | Diagnostic patterns for malformed records, IDs, references, and evidence |
| `src/compiled-cache.integration.test.ts` | Publication/restore, stale-cache, and vault-identity regression scenarios |
| `src/import-runs-state.ts` | Ingestion journal precedent for paths, hashes, snapshots, and resumable recovery |
| `src/query.ts` | Selective lookup/citation behavior only; do not inherit its complete search service |
| `src/corpus-supplement.ts` | Possible follow-up non-exclusive shared-memory adapter, not required for v1 |
| `README.md` and plugin registration/adapters | Review authority-model differences and per-agent lifecycle integration patterns |

Carry over applicable regression coverage for malformed YAML, Unicode filenames, code-fence links, nested/detached asynchronous mutations, agent isolation, and restored-vault races. Adapt expectations to the authoritative editable-vault contract rather than preserving incompatible compiler behavior.

## Implemented correction/withdrawal contract — 2026-09-23

See [CORRECTIONS.md](CORRECTIONS.md) for the exact shipped `knowledge_correct`
and `knowledge_withdraw` contracts, journal recovery, lifecycle guards and
dependency impact. These replace the earlier proposed forget/unlink tool names.
The current UI direction is read-only inspection with changes through agent
chat/tools; prior direct browser-edit requirements are superseded by
[UI_REDESIGN_SUPPORT.md](UI_REDESIGN_SUPPORT.md).
