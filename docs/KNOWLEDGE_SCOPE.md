# Knowledge: v1 Scope

**Date:** 2026-09-18
**Updated:** 2026-09-22
**Status:** V1 scope baseline; not implemented. Follow-ups are candidates, not release commitments.

## Product direction update — 2026-09-23

Knowledge UI is a read-only inspector. User-requested knowledge changes go
through chat and agent tools; prior direct editing/form requirements below are
superseded by [UI_REDESIGN_SUPPORT.md](UI_REDESIGN_SUPPORT.md). Correction and
withdrawal ship as agent operations, without browser forms or dialogs. See
[CORRECTIONS.md](CORRECTIONS.md) for the implemented lifecycle contract.

## 1. Product promise

> Capture knowledge with evidence, organize it into an editable Markdown vault, find it reliably, and correct it without losing history.

Knowledge is a native OpenClaw plugin, informed by gbrain's knowledge model and workflows—not a compatible reimplementation or an attempt to reproduce its full feature set.

Knowledge is intended to replace memory-wiki's knowledge-vault role, without depending on that plugin or taking over OpenClaw's memory or context-engine slots. Replacement does not imply feature parity or automatic migration.

The first release should complete this loop:

**Ingest → inspect in OpenClaw Control UI → retrieve → edit → correct → recover.**

Control UI is the primary interface for working with accumulated knowledge and inspecting the plugin as it operates. Markdown remains the portable storage format; Obsidian and ordinary text editors are optional, not required product interfaces. Build the native UI alongside each capability, beginning with a Knowledge sidebar page over the vault and ontology.

Autonomous intelligence is not a prerequisite for a useful, trustworthy knowledge system.

For unanswered design decisions, inspect gbrain's applicable schema, workflows, and implementation first and model Knowledge on that approach unless there is a concrete reason to depart. Record the reference and rationale for departures. Existing Knowledge scope, editable-Markdown authority, and native OpenClaw integration remain governing constraints; this default does not import gbrain's full feature set.

## 2. Relationship to the earlier specification

This document governs **v1 scope** where it differs from [KNOWLEDGE_SPEC.md](KNOWLEDGE_SPEC.md). The specification details the design contracts; its proposed tool catalog, skill count, and follow-up capabilities are not all v1 commitments.

In particular:

- An editable Markdown vault is in scope, with SQLite indexes and operational state—not SQLite-only authoritative knowledge.
- Named, versioned ontologies with local inheritance, selective borrowing, typed fields, aliases, and filing conventions are in scope; distribution and discovery are not.
- A native Knowledge sidebar page with record browsing/editing, ontology inspection, and activity/issues is in scope; a separate frontend application is not.
- Embeddings, scheduled dreaming, proactive recall, and graph-assisted retrieval are follow-ups.
- Existing evidence, access, correction, revision, and retry-safety principles remain applicable.

## 3. Must-have capabilities

| Area | Required for v1 | Boundary |
|---|---|---|
| Portable vault | Markdown/frontmatter, stable record IDs, wikilinks, external-edit detection, conflict preservation, rebuildable indexes | One vault and one OpenClaw publishing instance per agent; transport is user-managed |
| Ontology | One shipped default with named/versioned local inheritance and selective borrowing, typed fields, relationship endpoint constraints, aliases, filing conventions, effective fingerprint and inspection | No distribution marketplace, automatic discovery, or automated taxonomy migration |
| Native Control UI | Knowledge sidebar page: Records, Ontology, and Activity & issues; basic page editing, evidence/history inspection, and live state refresh | No external knowledge app required; no graph visualization, rich-text editor, or visual schema builder in the foundation |
| Records and evidence | Pages, entities, attributed claims, inspectable sources, corrections, withdrawals, and mutation history | No prediction-calibration or automatic outcome-grading subsystem |
| Relationships | Explicit typed relationships, Markdown-derived backlinks, direct neighbor lookup | No multi-hop answer engine, graph-assisted ranking, or inferred relationships |
| Uncertain extraction | Preserve unresolved identities and source attribution without a record-approval workflow | No specialized review queue or elaborate promotion-policy engine |
| Retrieval | Exact ID/name/alias lookup, keyword search, filters, useful snippets, citations, and separate exhaustive listing | No required embedding provider, reranker, or query expansion |
| Ingestion | Complete text/document and meeting-transcript workflows, duplicate checks, resumable progress, and honest partial outcomes | Use host capabilities for acquisition and extraction; no new connector or transcription stack |
| Reliability | Revision checks, retry safety, interrupted-write recovery, backup/restore procedure | No distributed writers or sophisticated automatic merge system |
| Evaluation and diagnostics | Focused acceptance suite; native activity/issues view for incomplete ingestion, conflicts, missing artifacts, and index failures | No benchmark platform or generalized monitoring dashboard |

### 3.1 Preserve meaning without building every future feature

Claims must distinguish source statements, user beliefs, and agent inferences through attribution, a small claim-kind vocabulary, evidence references, and lifecycle status. Unknown information stays unknown.

Created records are immediately available. There is no candidate/accepted state, promotion, review queue, or approval step. Active/superseded/withdrawn lifecycle and source attribution remain independent of publication/index progress.

Do not collapse extraction confidence, a speaker's confidence, evidential support, and current validity into one ambiguous score. V1 does not need numerical confidence fields for all of these.

### 3.2 Relationships without graph reasoning

Store relationship endpoints, labels, and evidence. Track explicit relationships separately from links derived from documents: removing a wikilink must not erase an independently evidenced relationship.

Backlinks and direct neighbors are useful immediately. Graph-aware search and multi-hop reasoning can be added later.

### 3.3 Complete workflows, bounded acquisition

The OpenClaw agent executes ingestion skills using deterministic Knowledge operations. The plugin owns storage guarantees and durable checkpoints; the host owns model execution and available acquisition tools.

A meeting workflow must retain its source, resolve or flag participants, capture supported decisions and commitments, link relevant records, and verify its outputs. Saving only a meeting summary is not equivalent to completing ingestion.

For documents requiring extraction, audio, or images, use available host extraction/transcription/OCR capabilities. If a capability is missing, retain the available source and report a partial result. Never claim transcript verification from summary-only input.

Capturing a commitment does not schedule a reminder or execute a task. Requested curation can run as an ordinary agent workflow; scheduled dreaming is not required.

## 4. Storage and interoperability contract

| State | Authority |
|---|---|
| Pages, entity profiles, portable claims, relationships, citations | Markdown/frontmatter in the vault |
| Type and filing definitions | Versioned, human-readable ontology definitions |
| Retained originals and derived source artifacts | Durable artifact files, with provenance and integrity metadata |
| Search indexes, backlinks, and other derived views | Rebuildable SQLite projections |
| Receipts, checkpoints, publication recovery, mutation history, withdrawal safeguards | SQLite operational state |

Structured claims and relationships need a documented representation that can be reconstructed without an LLM. Stable identities must survive file renames. Start with one independently addressable page, claim, or relationship per Markdown file; entity profiles are typed pages, not duplicate records. Exact field syntax remains implementation design work. Keep the portable record envelope, configurable domain ontology, and operational database schema distinct.

### Editable vault boundaries

- Support primary reading, navigation, and basic page editing through Control UI, with optional independent reading/editing through Obsidian or an ordinary text editor.
- Detect external edits, renames, and deletions; do not silently overwrite conflicting changes. Preserve edits throughout authoritative documents, including user-authored metadata—not only designated human-note blocks.
- Use one OpenClaw publishing instance. Simultaneous autonomous publishing from multiple machines is not a v1 guarantee.
- Use local Git history by default whenever Git is available: initialize a vault repository and commit each publication/change batch. A stateful storage service owns file, SQLite and Git coordination. Missing Git does not block knowledge use. Leave GitHub, remote pushes/pulls and cloud-file transport out of scope; do not build a synchronization service.
- Do not synchronize the live SQLite database through a file-sync client.
- Define recoverable publication across files and SQLite; they cannot share one atomic transaction. Accepted, published, and indexed states must not be confused.
- Keep withdrawals effective when stale files reappear through synchronization.
- Bind derived indexes and publishers to vault identity and compatible publication generations. Restoring an older vault or reusing its filesystem path must not expose incompatible newer indexes or allow a stale publisher to overwrite it.
- Preserve malformed or ambiguous files and report diagnostics, including malformed frontmatter, duplicate IDs, and broken references; do not silently discard content or guess a repair.

Git preserves the tracked vault, not the entire application state. Full recovery requires the vault, retained artifacts, and a consistent operational-database backup. V1 must document and exercise this distinction.

## 5. Host integration and access

- One logical knowledge store per OpenClaw agent.
- Coexist with the selected memory and context-engine systems; do not take either slot or automatically synchronize `MEMORY.md` or `USER.md`.
- Use trusted host context for access decisions across reads, writes, history, artifacts, and relationship traversal. Model-supplied identifiers cannot broaden authority.
- Preserve agent-private versus explicitly conversation-scoped access in plugin operations. An exported vault is also readable by anyone given filesystem access; plugin filtering is not a file-sharing security boundary.
- Explicit remembering and requested ingestion work in ordinary agent turns. Ambient capture and automatic context injection are not v1 requirements.
- Reuse OpenClaw execution, scheduling, provider, and acquisition facilities rather than introducing another runtime.
- Use the feature-plugin foundation for the native sidebar page, shared typed backend operations, and event-driven refresh. UI and agent entry points must share storage/access enforcement; the browser does not write files or SQLite directly.

The implementation goal is to reuse the existing technology stack without new required third-party dependencies. Packaging and supported SDK access still need validation; this is not a proven compatibility claim.

### 5.1 Selective implementation reuse

Use memory-wiki as a source of suitable engineering and regression cases, not as a runtime dependency or the architecture to inherit. Candidates include guarded filesystem operations, Markdown/frontmatter utilities, link parsing, mutation coordination, diagnostics, and host-integration patterns. Borrow publication/restore invariants and ingestion-progress tests where applicable.

Prefer supported OpenClaw SDK helpers; otherwise adapt small modules with their relevant tests and attribution. Do not import memory-wiki internals. Knowledge must own its authoritative editable-record format, external-edit reconciliation, access enforcement, correction/withdrawal semantics, and recoverable file/SQLite publication contract.

Memory-wiki's compiled-page authority model, complete claim schema, search service, memory bridges, and automation are not v1 requirements. Optional shared-memory search integration and migration tooling remain follow-up candidates. Reuse must not expand the product scope.

### 5.2 Introspection is part of feature delivery

Every capability includes an authorized view of its inputs, durable outputs, current state, and failures. Begin with Records, Ontology, and Activity & issues; extend these as ingestion, retrieval, correction, and recovery arrive. Show real service state, not optimistic completion inferred from agent prose. Distinguish lifecycle from publication/index state; publication progress is not user approval.

The page must identify the active agent/vault and distinguish loading, empty, disconnected, invalid, and unavailable states. Reconnect refreshes authoritative snapshots; live notifications are not durable history. Hot reload is a development requirement to exercise, including cleanup and state recovery, not permission to discard in-flight work.

## 6. Follow-ups

### Bundled skills baseline and next backend milestone

After file-evidence activation and verification, port the originally scoped
workflows into repository-owned skills shipped with this plugin. Use semantic
ports of gbrain procedures, Knowledge terminology, and the actual shared tool
contracts—not command-name substitution or a second skill-management system.

The original candidate bundle is knowledge-recall, knowledge-capture,
knowledge-ingest, knowledge-meeting-ingest, knowledge-media-ingest,
knowledge-entities, knowledge-correct, and knowledge-curate. Begin with shared
source/identity/citation conventions and document/meeting ingestion, supported by
recall, capture, and entity handling. Read upstream workflows in full, preserve
license attribution, and explicitly map unsupported operations before authoring.
Do not advertise claim/relationship mutation, correction, media extraction, or
resumable multi-record ingestion until its required backend/host support exists.

After the backend dependencies below and skill upgrades, exercise the shipped
discovery/routing and capture-to-retrieval loop on a small
representative document and meeting transcript: retain originals, resolve existing
entities, distinguish statements from interpretation, verify citations by readback,
and repeat/interrupt/resume without duplicate outputs or false completion. Include
ambiguous speakers, corrections, and contradictory evidence as realistic cases.
Use findings to refine the workflows before bundling the remaining workflows.
The first five page-based workflows are now bundled: recall, capture, document
ingestion, meeting ingestion, and entity handling. See [WORKFLOWS.md](WORKFLOWS.md)
for the supported operation map and deliberate departures. Shared conventions,
source retention and individual-publication recovery are exercised in isolated
contract trials. Structured claim/relationship writes and entity metadata edits
are now implemented as a backend/UI milestone. A correction skill and correction/withdrawal mechanics are now implemented. Dedicated media/curation
skills and multi-record ingestion checkpoints remain missing.

After the implemented [structured-write foundation](STRUCTURED_WRITES.md), the
next milestones are correction/withdrawal, durable ingestion checkpoints, and
upgrades to the bundled skills. Full real-content document/meeting agent trials follow those dependencies;
small deterministic fixtures validate each backend slice during implementation.
Media and curation follow, then the remaining recovery/reliability acceptance.

### Next: improve finding and using knowledge

- Semantic retrieval, if representative cases show keyword search is insufficient.
- Better entity resolution and ambiguity handling.
- Bounded, opt-in proactive context pointers with repetition suppression.
- Richer relationship queries and graph-assisted retrieval.
- Better retrieval explanations and operational views.

These are independently useful improvements, not a mandatory bundle.

### Later: make the knowledge improve itself

- Scheduled consolidation and dreaming through OpenClaw execution.
- Cross-document synthesis, pattern discovery, and contradiction review.
- Ontology suggestions, migration tooling, and reusable distribution artifacts.
- Prediction models, outcome review, and calibration.
- Open-loop workflows for outstanding commitments and responses.
- Continuous ingestion and broader connector coverage.

Generated hypotheses must retain evidence and remain distinguishable from facts. Repeated synthesis must not count as independent corroboration.

### Outside this product's initial direction

- A separate MCP/OAuth server or remote-client platform.
- A second agent runtime, provider gateway, scheduler, or general-purpose job system.
- Multi-brain federation, repository federation, or model-facing source routing.
- Specialized code intelligence or arbitrary graph/SQL execution.
- A second owner for reusable skills and procedural memory.
- A separate Knowledge web application or generalized dashboard framework; the native Control UI page is required.

## 7. V1 acceptance criteria

V1 is complete when the following work end to end, with focused executable checks for the critical guarantees:

1. **Capture:** Ingest a document and a meeting transcript into sourced pages, claims, and relationships; unresolved identities remain explicit.
2. **Inspect:** Open Knowledge from the Control UI sidebar; browse records, structured fields, evidence, raw Markdown, ontology definitions, and activity/issues. Also read the vault and navigate working links without OpenClaw using an ordinary editor or Obsidian.
3. **Retrieve:** Find records by exact identity, alias, and keywords; return inspectable citations; distinguish ranked results from complete listings.
4. **Edit:** Create/edit a basic page in Control UI and through an agent operation using the same write contract. Reconcile external edits throughout authoritative documents, including user-authored metadata, and a rename while preserving identity; preserve and report a concurrent edit conflict without relying on designated human-note blocks.
5. **Correct:** Supersede or withdraw a claim while preserving its history and evidence; exclude withdrawn claims from active retrieval, including after a stale-file import.
6. **Resume:** Interrupt and retry a multi-record ingestion without duplicate outputs or a false completion report.
7. **Recover:** Rebuild derived indexes from the vault and restore a full backup with operational state and artifacts intact. Reject incompatible newer indexes and stale publishers after an older-vault restore or vault replacement, including reuse of the same path.
8. **Diagnose:** Distinguish “no matching knowledge” from failed indexing, missing evidence, and incomplete ingestion. Report malformed frontmatter, duplicate IDs, and broken references without silently losing content.
9. **Respect access:** Verify that inaccessible records do not leak through results, counts, backlinks, history, or artifacts.
10. **Observe live:** Agent writes appear in the native page and UI writes are readable by the agent. Reconnect and plugin reload recover current snapshots without duplicate watchers, stale handles, lost published writes, or discarded editor drafts. Failures and pending indexing remain visible.

No broad public benchmark suite is required to satisfy these criteria. Use a small representative corpus and realistic interruption/conflict cases.

## 8. Remaining implementation decisions

Settle the portable record format, ontology-definition format, and supported SDK/storage boundary for the first read-only slice. Before writable use, settle the file-publication recovery protocol; complete the concrete backup procedure before v1 acceptance. Final tools, skill packaging, and APIs should serve the scoped workflows rather than mechanically preserve the earlier catalog.

These decisions must not silently expand the release. Prefer the smallest implementation that fulfills the product promise; add intelligence incrementally after the capture-to-recovery loop is reliable.

## 9. Foundation milestones

Build a working Knowledge explorer alongside the data foundation, not a complete storage engine followed by a UI. These milestones establish the foundation, not completion of all v1 workflows.

| Slice | Deliverable | Completion check |
|---|---|---|
| 1 — Read a real vault | Feature-plugin scaffold and sidebar page; portable record envelope; initial declarative taxonomy; schema validation; record list/detail and diagnostics over a fixture vault | Inspect a project, person, sourced claim, and explicit relationship. Malformed records and schemas remain intact and visibly diagnosed. No writes are enabled. |
| 2 — One trustworthy write path | UI page creation/editing and an agent operation over the same service; revision/hash checks; durable journaled publication, receipts, automatic local Git history when available, and retained text evidence | A UI save is readable by the agent, an agent save is visible in the UI, and concurrent external edits preserve a conflict. Interrupted writes are recoverable before real knowledge is saved. |
| 3 — Live behavior and recovery | Event-driven refresh; reconnect snapshots; external-change reconciliation; recovery exercises; browser/backend reload lifecycle cleanup | Observe real changes, inspect a failure, reconnect/reload, and continue with consistent state and preserved unsaved work. No duplicate watchers or stale database handles. |

Do not defer journaling until after writes exist. Keyword indexing can follow the minimal record catalog; graph visualization, rich-text editing, semantic retrieval, and background intelligence are not foundation blockers. See the specification's foundation implementation sequence for concrete contracts and acceptance gates.

## Ontology foundation milestone — 2026-09-22

Implemented local composition, the reviewed gbrain-based default, shared resolver/inspection/filtering, effective fingerprinting, and fail-closed typed validation in the read-only explorer. See [ONTOLOGY.md](ONTOLOGY.md) for the exact contract and taxonomy decisions. The visible sample uses the shipped default unchanged; invalid examples live in test fixtures.

## Real-vault read foundation milestone — 2026-09-22

Implemented one configured agent vault, trusted private/conversation read access, guarded filesystem reads, and a durable SQLite identity checkpoint. See [REAL_VAULT.md](REAL_VAULT.md) for the implemented contract and limitations. Writes remain disabled. Next is Slice 2: shared UI/agent create/edit with journaled publication, revision/hash conflicts, retry-safe receipts/history, and retained text evidence. Ingestion follows the writable foundation.
