# Correction and withdrawal

Implemented agent operations, not browser editors. The Knowledge UI inspects
records/history and can hand a request to chat when the host supports composition.
The shared backend enforces the same trusted scope as other tools; these two new
actions reject non-tool invocations. Legacy create/page-save transport remains
compatible, but the redesigned UI offers no direct write controls.

## Exact operations

`knowledge_correct` accepts:

- `requestId`, exact target `id`, `expectedRevision`, `expectedHash`, `reason`.
- Optional `expectedVaultId`; required current `expectedOntologyFingerprint`.
- `replacement`: `{ kind: "claim", ...complete claim fields }` or
  `{ kind: "relationship", ...complete relationship fields }`. The replacement
  has no request ID, client-selected ID, or lifecycle fields. Its kind must match
  the original. Evidence/attribution/ontology validation matches creation.

The target must be a valid active-lifecycle claim or explicit relationship;
expired assertions may be corrected. Complete replacements avoid ambiguous
patch/omission semantics. The replacement cannot depend on the original or its
known dependents. New evidence does not automatically supersede anything.

`knowledge_withdraw` accepts `requestId`, `id`, `expectedRevision`, `expectedHash`,
`reason` and optional `expectedVaultId`. It withdraws one uniquely identifiable, envelope-readable page, claim or
explicit relationship, including a superseded original or a record with validation
findings (for example, missing evidence). Malformed/ambiguous identity still needs
recovery review. Already-withdrawn records
reject a new request; the original exact request remains retryable. Withdrawing
one edge never matches/withdraws other edges by endpoint pair.

Both operations reject missing/ambiguous/inaccessible/stale targets without
accepting a receipt. Reasons must be nonblank. Pages are corrected by ordinary
revision-fenced page edits, not replacement entity identities. A page whose
inactive dependency blocks discovery can still be edited by exact ID to repair
its dependencies; new references must satisfy ordinary active-scope checks.

## Portable lifecycle and inspection

Original contents and evidence remain intact. A correction advances the old
record's revision, sets `lifecycle: superseded`, `superseded_by: <replacement ID>`,
and `lifecycle_change: { reason, at, actor, request_id }`. The replacement has a
new identity, revision 1, `supersedes: <original ID>`, and the same change reason.
Withdrawal advances the target revision, sets `lifecycle: withdrawn`, and records
its reason/actor/time/request. YAML comments and unrelated fields survive.

Receipts include `operation`, `targetId`, `replacementId` for corrections,
`reason`, and `impact`. The receipt's primary ID/hash/revision identifies the
replacement for corrections and the changed target for withdrawal. Exact
`record` metadata, `history` for either ID, `revision` and `mutation` provide
inspection. Correction mutation material includes both records in one receipt.

`impact.items` lists authorized direct and transitive machine-readable dependents
(`dependencies`, entities, owner, relationship endpoints), with ID/title/kind and
`direct`; `total` is the number listed. These are unresolved impacts at acceptance,
not evidence of automatic repair. No semantic prose-copy detection, cascading
rewrite, redirection or deletion happens. Agent follow-up uses exact inspection
and may repair supported records or report them unresolved.

Default lookup, keyword search, connections, records and ontology/status record
counts use current eligibility. Inactive records and their dependents are excluded
before counting/paging. `records({lifecycle:"all"})` explicitly requests a historical
inventory (including invalid/withdrawn records); exact record/history reads remain
available in the authorized scope. Historical lookup/search includes superseded
but never withdrawn records. Search remains ranked; records remains exhaustive
within the existing bounded scan, not a claim to scalable thousands-record support.

## Journal and recovery

Correction uses the existing single publication journal with two record file
changes and one manifest advance. Receipt, both history entries, observations,
lifecycle guards and Git batch are committed together in SQLite after files
publish. Old single-record plans remain readable. Global pending/conflict fencing
prevents all plugin catalog reads from exposing an incomplete mutation. External
filesystem readers can observe intermediate files; there is no cross-file OS
transaction. Accepted intent is not publication; `published` is the completion
state. Git/index status remain separate.

Lost response or interruption: repeat the exact request/payload, or resume the
accepted request. It returns the same replacement/receipt without duplicating
history. A request ID with changed payload is rejected. External edits, deletion,
unsafe paths and generation/root mismatch retain existing fail-closed behavior.
Conflicts preserve proposed/original/displaced material and block the catalog;
resume never overwrites a conflicting edit. Recovery review remains manual.

Durable `lifecycle_guards_v1` state extends existing withdrawal safeguards to
supersession. Guards are scoped by vault identity and trusted partition, survive
service replacement/index rebuild, and cannot be cleared by restored active
Markdown. Withdrawal dominates supersession. Existing `keyword_withdrawals_v1`
tombstones remain effective after upgrade. Exact inspection reports effective
lifecycle/linkage even if stale raw Markdown says active; raw/history remain
faithful to stored bytes. No automatic rewriting of imported stale files occurs.

These tables are **operational safeguards**, not disposable search projections.
Back up/restore them with receipts/journal and retained artifacts. Restoring only
Markdown/Git cannot reconstruct a tombstone for an absent old record. Withdrawal
is not physical erasure of originals, history, exports or backups. Undo/unwithdraw
and automated conflict repair are not implemented.

## Verification

`test/lifecycle.test.mjs` covers original/evidence retention, chains, exact retries,
wrong-kind/stale/inaccessible targets, hidden scope isolation, two-record crash
boundaries, pending-read gating, conflict preservation, durable stale-restoration
suppression, current-discovery counts, dependency impact, page repair, typed-edge
identity, and agent-only lifecycle entry points. Tests use isolated synthetic
vaults, never the configured live knowledge store.

The repository-owned `knowledge-correct` workflow is a semantic port of gbrain's
pinned correction-pipeline discipline, using this journal rather than separate
forget/remember writes. See [WORKFLOWS.md](WORKFLOWS.md) for departures and attribution.
