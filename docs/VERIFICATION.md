# Bundled workflow skills — 2026-09-23

## Structured-write foundation — 2026-09-23

- `npm run check`, `npm test` (**131 passed**), `npm run build`,
  `npm run validate`, and `git diff --check` passed.
- Added 14 structured-write tests: all claim kinds/origins, sourced decisions,
  date-only/offset temporal fields, owned/undated commitments, explicit edges,
  reverse dependencies/pagination, metadata replacement/preservation, aliases,
  malformed evidence/dates/endpoint types, expired assertions, access/withdrawal
  boundaries, cross-operation request collisions and interrupted/restarted writes.
  Reference and evidence races immediately before acceptance reject publication.
- `node test/browser/live-state.mjs` passed the existing rendered regression.
  `node test/browser/structured-writes.mjs` passed native claim/edge creation,
  typed readback, unsaved draft reload, exact replay after a lost save response,
  retained locators, agent-created event live refresh, native metadata edits,
  connection display, mobile overflow and absence of browser errors. All writes
  used isolated temporary vaults, not the user's vault.
- Inspected the captured mobile editor and exercised the delivered UI through
  the feature-client/service harness. This is rendered isolated verification,
  not a visual inspection of the user's live Control UI tab.
- Verified the existing linked install points to this checkout and inspected its
  accepted surface before activation. `plugins reload knowledge --accept-capabilities
  --json` succeeded: `restartRequired: false`, runtime generation 4. A fresh
  `plugins.sessionAction` read reports `structured-writes-1`, writes enabled,
  watcher active, the same two records and zero findings. The new `connections`
  action returned a valid empty result for a nonexistent ID. No synthetic live
  writes, gateway restart or manual config replacement was performed.
- The current turn's already-bound status tool still reported its old instance
  after hot reload; verification therefore used a fresh gateway feature invocation,
  not that stale tool binding. New tool visibility in an already-running turn is
  not inferred from the reload receipt.
- Background extraction, correction/withdrawal, ingestion checkpoints, dedicated
  chronological timeline presentation and full workflow trials are not delivered
  by this change. See STRUCTURED_WRITES.md for the boundary and API decisions.


- Five repository-owned skills shipped through the plugin manifest and npm file list: recall, capture, document ingestion, meeting ingestion, and entity handling. Shared references are generated inside each skill directory so host per-skill materialization remains self-contained.
- Upstream workflow/convention files were read in full and byte-compared to gbrain commit `7cdc3e30a898665a8c87b0c06937f6366f759f6c`. MIT attribution and explicit supported/unsupported operation mapping are in `THIRD_PARTY_NOTICES.md` and `WORKFLOWS.md`.
- `npm run check`, `npm test` (**117 passed**), `npm run build`, `npm run validate`, five skill-creator validations, and `git diff --check` passed. The Python validator ran in an isolated temporary venv because the system Python lacked PyYAML; no project dependency was added.
- New tests exercise the actual public feature adapter and storage in temporary vaults: source retention/download, exact citation locators, existing entity lookup, ambiguous names, conflicting document/transcript evidence, attributed prose correction, retained original/history, interrupted uploads, lost-save-response replay, service replacement, and retrieval/readback. These deterministic authored-output tests do not prove model routing or extraction judgment. No test content was written into the user's vault.
- `npm pack` produced `openclaw-plugin-knowledge-0.1.0.tgz` with all five entrypoints, nine per-skill reference files, shared sources and attribution. Package tests check self-contained reference closure, schema-valid discovery metadata, actual tool names, reference freshness and payload inclusion.
- The separate `openclaw plugins pack` artifact builder rejected the plugin's pre-existing module-relative runtime reads for the default ontology/sample vault. The regular npm package and linked-install route work; artifact activation packaging remains unsupported. No unrelated backend resource-loading change was made to bypass that restriction.
- Inspected the running gateway and linked Knowledge install, then accepted the new skill surface and reloaded using the current gateway checkout's CLI. Receipt: `ok: true`, `restartRequired: false`, runtime generation 3. `skills list --agent main --json` lists all five skills as eligible and model-visible. This is discovery verification, not proof that this already-running turn has received refreshed skills.
- All **14** skill entrypoint/reference files were fetched through live `plugins.skills.read`: complete inventories, ready text, and byte-identical content to the checkout. Installed plugin inspection reports the skill root accepted and no diagnostics.
- An in-flight dynamic tool still referenced the retired instance (`live: stopped`); a fresh authenticated gateway session-action status verified the replacement instance, `live: watching`, two valid existing records, 38 definitions and zero findings. No vault configuration or content was changed by this task.
- Next: user-provided real document/meeting trials and model-level workflow evaluation. Claim/relationship mutation, lifecycle correction/withdrawal, media extraction, and resumable multi-record jobs are not supplied by these skills.

---

# File-backed evidence and immediate publication — 2026-09-23

- Retained originals now use file-backed, hash-verified evidence with resumable,
  idempotent chunk uploads and paginated source inspection. Removed the
  48,000-character source and 20-reference storage caps; transport and previews
  remain bounded. New pages are immediately searchable without an approval step.
- `npm test`: **113 passed, 0 failed**. Includes the actual OpenClaw feature
  adapter at the maximum upload/download chunk size, interruption/retry,
  authorization/filesystem boundaries, binary preservation and source pagination.
- `node test/browser/live-state.mjs`: **18 rendered checks passed**, including
  23-file upload, source pagination, byte-exact browser download and retained
  attachments across lost-save-response recovery and reload.
- `npm run check`, `npm run build`, `npm run validate`, and `git diff --check`:
  passed. Backend revision: `file-evidence-1`.
- Live testing found that 64 KiB decoded chunks exceeded the host's JSON string
  bound after base64 encoding. Upload and download chunks now use 48 KiB decoded;
  the feature-adapter regression test exercises this host boundary.
- Plugin hot reload failed with `Worker environment inventory has closed`.
  A gateway restart activated the corrected build; live service start was
  `2026-09-23T10:05:01.600Z`.
- After restart, the actual native Knowledge editor uploaded a **119,056-byte**
  synthetic binary, published its page and showed verified evidence. Downloaded
  bytes matched the original exactly (SHA-256
  `805410926e6289fa695ee1c820bd610ec1789818808dda7b33cac3bc6ef28857`).
  The page and verified attachment survived a full browser reload.
- Live download verification used the supported Blob fallback by disabling the
  OS picker in the test page. The native save dialog is **not verified** in
  headless Chromium. No backend or attachment responses were mocked.
- Local live artifacts: `/tmp/knowledge-attachment-live-20260923/` contains the
  result, verification script, screenshot and original/downloaded binary.
  The private vault retains a clearly labeled synthetic verification page;
  it is not real knowledge or an ingestion-completeness claim.
- The next bundled-skill milestone is recorded in `KNOWLEDGE_SCOPE.md`; no skills
  have been authored or installed by this change.

---

# Integrated retrieval and live-state reliability — 2026-09-23

Merged keyword retrieval into `fix/live-state-reliability`, preserving draft recovery,
watcher lifecycle fencing, vault identity preconditions and exact retry behavior.

- `npm run check`, `npm run build`, `npm run validate`, `git diff --check`: passed.
- `npm test`: **101 passed, 0 failed**, including retrieval and retired-service checks.
- `node test/browser/live-state.mjs`: **15 rendered checks passed**. Adds default
  candidate exclusion, explicit candidate results, live search refresh retaining
  selection/filters, and background refresh retaining input focus to the existing
  draft/retry/conflict/reconnect/cleanup/mobile coverage.
- Generated manifest rebuilt from the combined code. Backend revision:
  `keyword-live-state-1`.
- Live activation and real-vault verification are tracked separately below; the
  local checks above use isolated test vaults.

---

# Keyword retrieval verification — 2026-09-23

Isolated branch `openclaw/keyword-retrieval`, based on `aea7253`.

- `npm run check`: passed.
- `npm test`: **93 passed, 0 failed** (17 focused retrieval tests plus 76 existing tests).
- `npm run build`: passed; native UI assets and tool manifest regenerated.
- `npm run validate`: `valid: true`, plugin `knowledge`, no errors.
- `git diff --check`: passed.
- Retrieval coverage: title/alias/body FTS5, exact-name ambiguity, typed UI/tool contracts,
  literal modes/Unicode, filters before BM25, scope-isolated scores/counts/snippets,
  bounded revision/hash/line citations, invalid/duplicate/dependency exclusion,
  stale-edit/rename/delete reconciliation, withdrawal reappearance/restart/rebuild,
  injected index failure without stale fallback, authority and restore fences,
  unsafe filesystem links, publication-time lag/read-through, empty conversation scope.
- Dependencies use a local worktree symlink to the parent checkout's compatible
  `node_modules`; no committed dependency version changes.
- **No live reload, gateway configuration change, or real-vault mutation.** Native
  Search UI is compiled and its shared client contract tested; visual/browser
  interaction in the running host is unverified and left to the integration owner.
- Parent owns draft persistence, watchers/events/reconnect and live reliability.
  New search modules are isolated; shared service/storage/control-ui hooks must be
  merged with that work and the manifest regenerated after integration.

The sections below are earlier milestone reports, not current capability claims.

---

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
