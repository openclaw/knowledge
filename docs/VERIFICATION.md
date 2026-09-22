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
