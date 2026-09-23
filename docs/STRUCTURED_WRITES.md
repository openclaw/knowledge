# Structured writes: implementation plan

Date: 2026-09-23
Status: implemented locally, 2026-09-23. See [verification](VERIFICATION.md) for
checks and activation status. The original implementation sequence below is
retained as the acceptance plan; its “existing foundation” describes the baseline.

## Delivered contract and design decisions

- `knowledge_create_claim`, `knowledge_create_relationship`, and
  `knowledge_connections`; page metadata via `knowledge_save_page`.
- Both native UI and tools use the existing journaled publisher. Old page request
  hashes/journals remain compatible; new operation kinds bind request IDs to their
  operation and exact payload. No claim/edge update or lifecycle override is exposed.
- Evidence is mandatory and hash/locator verified. References must be active,
  authorized and unambiguous. Ontology fingerprints are required on assertion
  creates and optional for backward-compatible page clients (the UI supplies one).
- Date-only occurrence/due values remain dates. Offset timestamps preserve the
  supplied offset. Validity/expiry require UTC instants; validity is `[from, until)`.
  See [portable representation](FORMAT.md) and [API](MODEL_API.md).
- Dated event claims are timeline building blocks, linked to entities—not a second
  timeline store or duplicated timeline prose. A dedicated chronological timeline
  browser/query remains future presentation work. This follows spec §4 rather
  than gbrain's separate Markdown-plus-timeline-store operation.
- Unlike gbrain's fact dedup/supersession and optional untyped links, new request
  IDs remain distinct assertions, explicit edges require ontology labels and
  retained evidence, and corrections are a separate upcoming milestone. Gbrain's
  local `remember`, `add_link`, and `add_timeline_entry` implementations were
  inspected before making these choices. No dependency or background model added.
- Connection queries return separately labeled incoming/outgoing edges, reverse
  dependencies and entity/owner claims, with filtered totals, bounded evidence and
  snapshot-checked pagination. Historical inspection is explicit; ordinary
  Markdown links are never promoted to asserted relationships.
- Native forms create claims/edges, edit aliases/tags/dependencies, preserve exact
  submitted payloads across reload, and inspect assertion fields/evidence. Browser
  fixtures use an isolated vault, never synthetic writes in the user's vault.

Correction/withdrawal, ingestion checkpoints, full workflow upgrades, extraction
quality trials and background extraction remain deferred.

## Goal and sequence

Publish evidence-backed claims and explicit relationships, and edit entity
metadata, through the same recoverable service used by pages. This is the next
backend milestone, **before full real-content agent workflow trials**.

Delivery order: structured writes → correction/withdrawal → durable ingestion
checkpoints → upgrade bundled skills → real document/meeting agent trials → media
and curation → remaining recovery/reliability acceptance. Small deterministic
document/meeting fixtures validate each foundation as it is built.

Requirements already live in [scope §§3–5](KNOWLEDGE_SCOPE.md) and
[spec §§4, 6.3–6.4, 7](KNOWLEDGE_SPEC.md). This plan turns those requirements into
implementation slices; it does not claim those capabilities have shipped.

## Existing foundation and reuse

- `src/model.ts` and `src/vault.ts` already read and validate portable claim and
  relationship records, evidence, entity references, and dependencies.
- `src/mutation-contract.ts` exposes only `SavePage`; `src/storage.ts` prepares
  only page records. Reuse its journal, request replay, file/hash checks, receipts,
  reconciliation, history, publisher fencing, and Git checkpoints.
- Evidence retention/readback, ontology resolution, record inspection, exact
  lookup, keyword retrieval, and shared UI/agent adapters already exist.
- Page saves accept ontology-defined `fields`, but do not expose aliases, tags,
  or dependencies. Structured temporal and commitment fields are not yet a
  validated portable contract. Existing reference inspection is not a complete
  typed incoming/outgoing relationship interface.

No new database, graph engine, scheduler, or extraction runtime is needed. Before
settling unresolved semantics, inspect the applicable gbrain fact/link operations
and schema at the pinned reference used in WORKFLOWS.md; record specific departures.
Reuse the existing Knowledge publisher rather than importing gbrain persistence.

## 1. Fix the typed contracts and portable representation

Add shared service inputs for creating a claim and a relationship; extend page
create/edit for entity metadata. Keep the existing page operation compatible.
Tool packaging can follow the proposed remember/link operations or equivalent
names; browser and tools must call the same typed service.

- **Claim:** text, claim kind, assertion origin, attribution, nonempty evidence,
  optional entity IDs and dependencies. Keep unresolved speakers as attributed
  source labels, not fabricated person IDs.
- **Relationship:** existing page endpoint IDs, ontology-defined label,
  attribution, nonempty evidence, optional dependencies and validity interval.
  Store one directed edge; expose both traversal directions.
- **Page/entity:** aliases, tags, dependencies, and existing typed fields. Define
  omission as preserve on edit and explicit empty collections as clear; document
  replacement semantics. Alias collisions remain explicit resolution candidates,
  never proof that two records share an identity. Do not expose unrestricted
  frontmatter writes.
- **Temporal/commitment data:** make occurrence, validity, expiry, owner, and due
  fields explicit and validated where applicable. Unknown values remain absent;
  capture never schedules a task. Define date/time precision and timezone handling
  without inventing midnight or a timezone for a date-only source.
- **Common controls:** request ID, expected vault identity, revision/hash for
  edits, and effective ontology fingerprint for ontology-dependent writes. Host
  authority supplies scope, actor and storage timestamps. Callers do not set
  lifecycle to bypass future correction/withdrawal operations.

Specify bounds, errors, field applicability, filing paths, and backward-compatible
reading of current files. Distinguish factual replacement from an ordinary metadata
edit: this milestone must not introduce silent claim overwrite as a substitute
for the next correction milestone.

Gate: round-trip fixtures for every supported kind and optional field, including
unknown authored metadata; malformed combinations fail deterministically.

## 2. Generalize publication without weakening its guarantees

Separate kind-specific preparation/validation from the common journaled publisher.
Create server-owned stable IDs and filing paths, then preview the complete record
against the same vault/ontology snapshot used for publication.

- Validate authorized references, permitted endpoint types, active endpoints,
  evidence hashes/locators, temporal consistency, and ontology fingerprint.
- Fence reference/schema changes between validation and acceptance. No arbitrary
  caller path, cross-scope reference, or inaccessible-record existence leak.
- Preserve untouched metadata and prose on edits; revision/hash conflicts retain
  the proposed input and never silently overwrite external edits or resurrect files.
- Scope request identity across operation kinds: exact replay returns the same
  receipt/record, but changed payload or operation under that ID fails.
- Preserve accepted/published/conflict state, resumability, history, Git status,
  and service-reload fencing. Existing pending page journals must still recover.
- Keep exact read/list/history available after publication; disclose keyword-index
  lag separately. Publication is not proof of semantic truth or ingestion completion.

Request replay is not semantic deduplication. Same text or endpoint pair can have
different attribution, evidence, or validity. Resolve candidates before writing;
do not auto-merge or silently supersede. Cross-session source/output deduplication
belongs to the subsequent durable ingestion milestone.

Gate: create a sourced decision and an evidenced edge, lose the responses, retry
through a replacement service, and receive the original IDs without extra records.

## 3. Complete authorized reads and inspection

- Return structured claim/relationship fields, evidence, dependencies, and revision
  controls without requiring raw YAML parsing.
- Provide bounded incoming/outgoing explicit-edge views with label, endpoint,
  lifecycle and evidence. Include reverse dependencies needed for later correction
  impact discovery. Filter access before counts and pagination.
- Keep explicit edges distinct from ordinary Markdown links; prose links do not
  count as relationship publication. Derived backlinks remain a separate v1 task.
- Apply validated expiry/lifecycle rules consistently to active lookup/search and
  neighborhood views; keep authorized historical inspection explicit. Define and
  test validity-time behavior instead of treating every date as an expiry field.

Gate: navigate person → evidenced relationship → project and inspect a meeting's
decision, attribution and original quote; no inaccessible endpoint or dependency
leaks through a list, count, diagnostic, or history entry.

## 4. Deliver native UI and agent adapters together

Expose the typed mutations to agent tools and bounded native create/edit controls;
show claim kinds, assertion origins, entity references, relationship direction,
evidence, temporal fields, dependencies, and actual publication state. Extend draft
recovery to new inputs, including the exact submitted payload and preconditions.
Use shared backend validation, live refresh and explicit conflict messages.

Gate: an agent-created claim/edge appears in Control UI; a UI-created record and
entity metadata edit read back through agent tools. Reload preserves an unsaved
draft or allows accepted work to resume without a duplicate.

## 5. Verify and document the milestone

Focused acceptance cases:

1. Retain a short transcript; create person/project/meeting pages, an attributed
   decision, an owned commitment, and a supported typed relationship; read back
   exact source locators and structured fields.
2. Preserve contradictory assertions and unresolved speakers without guessing,
   merging, or overwriting. Demonstrate source/user-belief/inference distinction.
3. Reject missing evidence, invalid locators, invalid endpoint types, stale
   revisions, changed ontology, and unauthorized references without content loss.
4. Exercise interruption before/after durable acceptance and during publication,
   exact retries, changed-payload retries, external edits/renames, and reload.
5. Exercise date-only/undated commitments, expiry, ambiguous aliases, reference
   pagination, scope filtering, and deterministic index reconstruction.
6. Retain existing page-save, attachment, retrieval, and journal recovery behavior.

Run focused and regression tests plus repository-required check/build/validate;
verify UI/agent parity in an isolated vault before activation. Update FORMAT,
MODEL_API, WORKFLOWS and shared skill references only to describe working APIs.
Full agent extraction-quality trials follow correction and ingestion checkpoints.

**Done means:** supported tools and native UI can publish, inspect, retrieve and
retry sourced structured records with the same guarantees as pages. It does not
mean correction/withdrawal, multi-record workflow resume, semantic deduplication,
media extraction, curation, or full v1 recovery are complete.
