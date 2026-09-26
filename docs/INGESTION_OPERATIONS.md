# Bounded ingestion operations

Implemented 2026-09-24. Shared tool/feature contracts, agent-only batch writes;
no browser write flow, dependency, connector, scheduler or extraction engine.

## APIs

- **knowledge_verify**: 1–100 unique IDs and optional expectedRevision,
  expectedHash, owner, due_at, occurred_at. Explicit null means expected absence;
  omit to skip. One authorized scan validates evidence hashes/locators, references,
  links and active eligibility; reconciles keyword indexing and checks membership.
  Returns checked/passed/failed counts and exceptions only (20 default, 50 max).
  Paginate with unchanged records + snapshot; a changed snapshot is rejected.
  No body, quote, raw YAML, inaccessible target ID or full index result is returned.
  This proves structure, not truth, attribution, source completeness or intended
  link target correctness. A vault scan failure rejects instead of returning a
  misleading partial success. Existing scan-scale ceilings remain.
- **knowledge_publish_batch**: 1–25 items; max 1 MiB. Shape:
  `{ key, kind: "page" | "claim" | "relationship", input }`.
  Input matches kind. Shared UUID/vault/ontology at batch level. Unknown fields
  reject. Required fields/evidence stay required. Schema uses shared `$defs`;
  compact enough to keep agent-visible types. TypeScript infers same union.
  Refs: `@key`. Body links: `[[@key|label]]`. Prose/evidence untouched.
  Upload originals first. No inline source. Create: server ID. Edit: existing
  ID + revision + hash. Duplicate keys/targets or missing refs: reject before save.
- **knowledge_source_check**: provider/key/exact original-byte sha256. Latest
  authorized source-bound batch receipt returns missing/unchanged/changed. Registry
  lives in the existing publication plan/journal, not a new job/checkpoint subsystem.
  Legacy writes are not backfilled. Missing is not proof of absence. Unchanged
  publish_batch returns the old receipt without applying the submitted payload.
  Changed source requires an observed expectedPreviousRequestId and explicit agent
  reconciliation. The acceptance transaction fences this source-version comparison.
  Hash must match retained evidence; different source keys are never auto-merged.
  Historical receipts never authorize resurrection. Verify returned IDs first.
- **knowledge_mutation**: includeFiles=false for receipt-only inspection; file
  recovery is paginated, at most 3 files/call. Batches return totalFiles/nextOffset.
- **knowledge_record**: summary without explicit includeEvidence no longer copies
  related-statement prose. Existing content reads and UI evidence remain compatible.

## Publication and recovery

All items are prepared against the same authorized snapshot, then validated as
one overlay and accepted into one existing mutation journal. Forward references,
self-links, page edits and claims/relationships work together. Evidence and source
identity are rechecked at acceptance. Reuse exact batch UUID/payload after an
uncertain result; changed payload under that UUID rejects. Existing resume handles
all items. Receipt items share state/requestId/Git checkpoint; no per-item success
is implied while accepted/conflicted. Physical filesystem publication is sequential:
interruption may leave installed files, but no partial catalog is exposed. Conflicts
preserve recovery material and block reads, with no automatic overwrite/rollback.
No new database migration; existing mutation journals remain compatible.

A source binding covers only its batch, not the entire ingestion. For large or
split ingestions, retain separate stable publication-unit keys/receipts and use
existing connections to reconcile later enrichment. Do not use one source key for
several independently submitted batches expecting all of them to execute.
Corrections/withdrawals remain separate explicit revision-fenced operations.

## Existing-solution preflight and gbrain alignment

Reused Knowledge's typed contracts, evidence validation, overlay scanner, SQLite
mutation journal, publication fences, Git checkpointing and keyword index. No
external ingestion platform would preserve these local scope/recovery contracts
without replacing them. Reviewed the local gbrain meeting workflow's source-ID,
split-meeting and capture-dedup guidance and its source/hash-scoped state schema.
Knowledge deliberately stores only source-to-publication receipts here, not
extraction failure/tombstone/job state. Workflow progress stays with the agent;
source attribution remains a property of evidence, not something batch tools infer.

## Verification and measurement

Isolated tests cover linked batch publication; pre-acceptance rejection; multiple
interruption points; service replacement/exact replay; source version fencing;
withdrawal/rerun safety; scoped reads; compact receipts; expectation mismatches,
evidence damage and snapshot pagination. All synthetic artifacts stay outside the
live vault. See the recorded check results in the change report; these tests are
not an unseen-source LLM ingestion trial.

On the next comparable ingestion record calls, response bytes, retries, elapsed
time and structural failures, split between acquisition/upload and publication/
verification. No production-speedup claim is made from deterministic fixtures.
