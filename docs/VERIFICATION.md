# Automatic local Git history — 2026-09-23

- Implemented automatic local history for writable vaults when Git is available. Added `KnowledgeStorage` as the shared owner of reads, observations, SQLite, publication and Git; feature handlers no longer reach into the database or real-vault adapter directly.
- SQLite schema v3 adds an ordered scoped Git outbox and observed-file fingerprints. Exact publication/observation snapshots survive missing Git or repository failures. Published receipts and history expose Git state independently of save state; Activity & issues includes checkpoint status and retry controls.
- `npm run check`, `npm test` (**76 tests passed**), `npm run build`, `npm run validate`, and `git diff --check` passed. Package dry-run includes the storage/Git modules and local-history documentation.
- Thirteen Git-specific tests exercise default initialization, exact grouped content, clean index, actor provenance, idempotent retries, missing executable and ordered catch-up, staged/unstaged preservation including same-path staging, injected failures before/after ref publication, real process death after Git succeeds but before SQLite acknowledgment, observed edits/rename/deletion batches, scope isolation, read-only mode, parent-repository isolation, locks/detached HEAD, post-publication external races, hook suppression, unsafe repository links, and safe malformed/hidden Markdown/ontology inspection.
- Native Git's atomic ref transaction records the commit and checkpoint marker together. A restarted service recovered a process-killed checkpoint with one commit and synchronized the working index. Existing file/SQLite interruption and cross-process publisher tests also pass.
- README, v1 scope, design contracts, setup and model API now state default-on local Git and deferred GitHub/remotes. No new runtime dependency or remote operation was added.
- Built locally as `local-git-history-1`. No gateway reload, configuration change, or real-vault content mutation was performed. New UI status/retry controls were type-checked and bundled; rendered/live UI interaction was not verified in this change. Existing uncommitted work was preserved; no source-repository commit/push was made.

---

# Model-facing inspection — 2026-09-23

- Added catalog/definitions/sources/diagnostics ontology views, exact name/kind filters and pagination. Removed serialized effective definitions from the public response. Source YAML is an explicit selected-source read, never an arbitrary path.
- Record reads return one bounded content representation, optional structured metadata, explicit evidence-excerpt truncation and opt-in paginated references. The browser requests full bodies/metadata for editing and loads original Markdown only on demand.
- `npm run check`, `npm test` (**63 tests passed**), `npm run build`, `npm run validate` and `git diff --check` passed. New cases cover continuation/reassembly, source restrictions, invalid ontology inspection, output contracts, authority isolation for all opt-in views and UI vocabulary pagination. Existing mutation tests now request raw content explicitly and verify a stale request has no saved draft/receipt.
- Reused the isolated Chromium page-editor harness with the new API, explicit complete-content/metadata reads, and an additional custom-domain-field preservation assertion. Passed draft close/reopen, validation, lost-response identical retry, single creation, evidence verification, browser edit, stale rejection/local draft retention, mobile overflow and browser-error checks. Driver: `/tmp/knowledge-inspection-editor-verify.mjs`; artifacts: `/private/tmp/knowledge-editor-verification-v3Gc4v/`. This is not a live Control UI frame or visual/layout review of the full explorer.
- Serialized sample measurements: ontology legacy inspection **42,454 bytes**, new default catalog **7,710 bytes**, targeted project definition **826 bytes**; project record legacy **2,517 bytes**, new default **584 bytes**. These are bytes, not token estimates, and are specific to the bundled sample.
- README/setup/ontology docs now describe implemented journaled writes and distinguish mount-local editor drafts, accepted-publication recovery and pre-acceptance rejection. Full browser-remount draft recovery and full backup/restore are not claimed implemented.
- No FTS tool was implemented in this change. The proposed SQLite FTS5 retrieval boundary and OpenClaw/lossless-claw precedent are documented in [MODEL_API.md](MODEL_API.md).
- No gateway reload, configuration change or real-vault content mutation was performed. The built backend revision is `model-inspection-1`; running-service activation remains separate. Existing uncommitted publication work was preserved; no commit/push was made.

---

# Journaled-page foundation post-refresh verification — 2026-09-22

- Verified the already-refreshed runtime without another plugin reload, gateway restart, configuration change, or real-vault test write. The live backend reports `journaled-pages-1`, the configured private vault, **0 records, 38 definitions, zero findings**, and `writesEnabled: false`. The existing configuration still omits the opt-in write flag; this verification did not enable it.
- Eight authenticated gateway operations (`status`, `records`, missing `record`, `ontology`, `diagnostics`, `history`, missing `mutation`, and missing `revision`) passed the current shared output contracts. Vault file hashes were identical before and after these checks. Local results: `/tmp/knowledge-publication-live-results.json`; verification driver: `/tmp/knowledge-publication-verify.mjs`.
- All **17 publication tests** passed against isolated fixtures: create/edit and retained evidence, durable idempotency, stale revisions/hashes, external edits/renames/deletions, interruption recovery, actual process death, cross-process competing writers, conflict preservation, authority expiry, scope isolation, retained history, and identity fencing.
- Headless Chromium exercised the actual `pageEditor` module and stylesheet against the actual shared service using an isolated temporary vault and an operator-context double. Passed: draft close/reopen; fields and attribution validation; lost-response retry with an identical request and only one creation; verified source retention; edit/revision advancement; stale-edit rejection preserving both the newer saved version and the draft; 390px layout without horizontal overflow; no browser errors. Desktop/mobile screenshots were visually reviewed. Driver: `/tmp/knowledge-editor-verify.mjs`; screenshots and isolated state: `/private/tmp/knowledge-editor-verification-B3SYCD/`.
- The first browser-harness attempt correctly failed because its SQLite parent used macOS's `/tmp` symlink alias; canonicalizing the temporary fixture path fixed the harness. A second harness assertion incorrectly expected a trailing newline; the implementation correctly preserved the exact supplied body. No implementation changes were needed for these checks.
- This is **not** verification of writes through the running gateway or interaction inside the live Control UI frame. The refreshed tool inventory did not expose `knowledge_*` tools, so live agent-tool invocation also remains unverified. Shared operator/agent service behavior is covered by tests, not a live agent call. No commit or push was performed during this verification continuation.
- The historical reports below describe earlier milestones; their statements about unimplemented publication/history do not describe the current working-tree implementation. Ingestion, ranked retrieval, automatic watching, and full restore remain outside this verification.

---

# Real-vault read foundation verification — 2026-09-22

- Pre-commit recheck: TypeScript check, all **38 tests**, build, plugin validation, and whitespace checks passed again. The scope milestone notes now distinguish completed real-vault access from the upcoming writable foundation. No live reload or new browser/agent-tool verification was performed for this commit.
- Completed implementation checks before runtime refresh: TypeScript check, **38 passing tests**, build, plugin validation. No implementation changes were made during the post-refresh verification.
- Post-refresh inspection found the new backend loaded with an empty plugin configuration, still serving samples. Restored only `plugins.entries.knowledge.config` using a compare-and-set guard against `{}` and the previously prepared vault settings. The gateway applied this without restart or another explicit plugin reload.
- Live authenticated operator queries for `status`, `records`, `record` (missing ID), `ontology`, and `diagnostics` all passed their shared output contracts. Backend `real-vault-1`, agent `main`, scope `agent-private`, `sample: false`, writes disabled; **0 records, 38 definitions, zero findings**. No synthetic records were copied into the private vault.
- Read-only inspection of the Knowledge-owned SQLite database confirmed the persisted identity matches the vault manifest. Vault file hashes remained unchanged across the live queries.
- A supplied session selector was denied. The host ignores a standalone agent selector without a session key; live verification confirmed it cannot redirect the configured private scope.
- Live verification used the authenticated gateway operation shared by Control UI, not rendered browser interaction. Owner-direct/group agent authority is covered by service tests with host-context doubles; the Knowledge tools were not exposed in this verification turn, so live agent-tool invocation remains unverified.
- This is the read/access/identity foundation only. Recoverable writes, ingestion, durable indexes/history, and full restore remain unimplemented. The earlier milestone reports below are historical.

---

# Ontology browsing refresh — 2026-09-22

- Vocabulary unchanged: 19 page types, 19 relationships; no new entity types.
- Removed fingerprint, effective-definition JSON, source manifests, inheritance, and development status from the browsing UI. Technical inspection remains in the agent operation.
- Added category navigation, distinct page/relationship views, local search, plain-language descriptions, expandable fields/search terms/endpoints, and associated-record links.
- `npm run check`, `npm test` (21 passing tests), build, plugin validation, and whitespace checks pass. The extension acceptance case now verifies the added structured presentation fields in the shared contract.
- Headless Chromium component smoke check passed: all default groups/types, category filtering, alias search, empty/reset state, associated-record callback, relationship endpoints, custom page/relationship visibility, unavailable-state issue navigation, no horizontal overflow at 390px, and no browser errors. Screenshots reviewed at desktop/mobile sizes and in light/dark themes. Harness used the actual view module, CSS, and sample-vault result, not a static mockup.
- Live gateway ontology response passes the updated output contract with new descriptions, 38 definitions, and zero issues. Plugin activation was reported by a connected Control UI client after reload.
- Full interaction inside the user's live Control UI remains unverified because desktop automation stalled; the component browser check and activation receipt are separate evidence.
- Follow-up: removed the “Everything has a place” card and replaced fixed category colors, font, surfaces, and shadows with Control UI theme tokens. The browser harness covers live light/dark/custom token changes without remounting. Final bundle revision was independently recomputed from local assets and exactly matches the gateway catalog and a connected client's activated revision; no additional reload was needed.

---

# Ontology foundation verification — 2026-09-22

Milestone: named/versioned local ontologies in the read-only synthetic vault explorer. Not v1 completion or private-vault activation.

- `npm run check`, `npm test` (**21 tests**), `npm run build`, `npm run validate`, and `git diff --check`: passed.
- Acceptance coverage: custom extension through the shared inspector/listing/validation service; fields and exact relationship endpoints; symmetric aliases; path inference and explicit-type precedence; whole-definition overrides and provenance; root ordering; local selective borrowing; changed-parent/donor fingerprints; missing/cyclic/ambiguous/invalid ontologies; source preservation; large effective-definition output; original record/evidence/path/scan-budget guarantees.
- Live gateway queries for `status`, `ontology`, `records` (organization alias), `record` (verified claim evidence), and `diagnostics`: passed output-contract checks. Backend revision `ontology-1`, writes disabled.
- Live snapshot: **7 records, all valid; 38 effective definitions (19 pages + 19 relationships); zero findings.** Active ontology `knowledge-default@1.0.0`. Invalid examples are outside the visible sample.
- Plugin hot reload succeeded with `restartRequired: false`. A connected Control UI client reported plugin activation. This is an activation receipt, **not visual verification**.
- Visual browser interaction for the new Ontology view remains unverified: desktop automation did not return, so no claim is made about rendered layout, clicking associated records, or browser filter interaction in this milestone. The backend operations those controls use were exercised directly.
- Package dry-run confirmed inclusion of the default ontology and third-party attribution, and exclusion of test fixtures.

## Host compatibility note

The initially linked `/Users/jalehman/Projects/openclaw` CLI refused the existing schema-18 state database because that checkout only supports schema 17. The local, untracked `node_modules/openclaw` development symlink was repointed to the verified running gateway checkout, `/Users/jalehman/Projects/openclaw/.worktrees/gateway-pr-155134-a`. The committed dependency version did not change. No state database was downgraded, restored, or altered to bypass this check. The required build/validation commands then passed normally.

## Remaining boundary

Real-vault access enforcement, recoverable writes, revision/conflict handling, ingestion, ranked retrieval, automatic watching, and durable activity history are not implemented. Next: the shared real-vault create/edit contract before ingestion.

---

## Historical explorer verification (before ontology foundation)

The following describes the earlier prototype only; its fixture counts, schema API, and browser observations are not the current ontology milestone.

# Explorer verification — 2026-09-22

Milestone: read-only synthetic vault explorer, not v1 completion or private-vault activation.

- `npm test`: nine tests cover read preservation, representative records/evidence, pagination/filtering, rename identity, unknown metadata, duplicate IDs, schema rejection/ambiguity, evidence tampering, unsafe paths, malformed YAML/scope, and scan budget refusal.
- `npm run check`, `npm run build`, `npm run validate`: passed.
- Live gateway `status` and `record` queries: valid shared-contract responses, writes disabled, sample clearly identified.
- Control UI: record selection, structured metadata, verified source excerpt/line locator, schema cards (eight effective, one invalid), six diagnostics, name/alias and kind filters, empty state, explicit refresh, browser reload/remount. No page errors during smoke checks.
- Initial live reload acknowledged the four additional read-only tools with `--accept-capabilities`; reload receipt reported `restartRequired: false`. Both connected Control UI clients reported activation.

Expected fixture snapshot: 11 envelope-valid records (7 fully valid), 8 effective schemas, 6 findings. The malformed record is preserved and diagnosed outside the typed catalog. The invalid schema is preserved outside the effective schema set.

No external ingestion, journaled writes, production access enforcement, automatic file watching, durable activity log, ranked retrieval, or recovery guarantees are claimed.
