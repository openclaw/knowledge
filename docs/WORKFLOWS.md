# Bundled workflows

Knowledge ships seven automatically discoverable, repository-owned skills through
`openclaw.plugin.json` (`skills: ["./skills"]`) and the package file allow-list.
They are semantic ports, not a gbrain runtime dependency or a Workshop install.

| Skill | Route |
|---|---|
| `knowledge-recall` | Answer from saved Knowledge with inspectable citations; read-only |
| `knowledge-capture` | Save a short thought/snippet with exact source text |
| `knowledge-ingest` | Documents/articles/conversations, assertions, entity propagation and back-links |
| `knowledge-meeting-ingest` | Transcripts, speaker uncertainty, structured decisions/actions, chronology |
| `knowledge-entities` | Resolve identities; scoped, sourced profile creation/updates |
| `knowledge-correct` | Exact-target correction/withdrawal, retained evidence and impact inspection |
| `knowledge-source-ingest` | Canonical source identity, retained coverage snapshots and overlap-aware manifest diffing |

Read the selected SKILL.md, then its linked references. Shared guidance is authored
once in `skills/shared/`; `npm run skills:sync` embeds copies inside each skill.
This is intentional: OpenClaw's per-skill bundle reader/materializer does not
include siblings or allow `../` reference traversal. Build and prepack synchronize
copies; tests reject drift. Cross-workflow routing uses discoverable skill names,
not filesystem links to sibling bundles. No global skill installation is needed.

## Upstream review and operation map

Read in full and byte-compared to gbrain commit
[`7cdc3e30a898665a8c87b0c06937f6366f759f6c`](https://github.com/garrytan/gbrain/tree/7cdc3e30a898665a8c87b0c06937f6366f759f6c):
`skills/{query,capture,ingest,meeting-ingestion,resolve-before-asking,enrich,brain-link-discipline}/SKILL.md`,
`skills/_brain-filing-rules.md`, and `skills/conventions/{quality,untrusted-content}.md`.
The upstream MIT attribution is retained in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
Existing Knowledge tools and host acquisition are sufficient for these workflows; no new runtime, connector, extraction dependency or paid service
is added.

| Upstream operation / practice | Knowledge port or explicit boundary |
|---|---|
| query/recall, search, get_page | `knowledge_lookup`, `knowledge_grep`, `knowledge_record`; agent synthesis over evidence, no semantic search |
| capture / put_page | `knowledge_save_page`; observed revision/hash for edits, exact request replay, readback |
| content-hash capture dedup | Scoped source ID/hash batch receipts via `knowledge_source_check`; exact source reuse, changed-source reconciliation, and legacy record lookup remain distinct |
| upload-raw / put_raw_data | `knowledge_attach`, file evidence on page, `knowledge_attachment`; local originals, no cloud routing |
| filing rules | Inspect `knowledge_ontology`; canonical type and server-generated descriptive path; use the returned path |
| raw transcript / attribution | Retained original + labeled derived transcript; exact locators, unresolved speaker map, source-vs-inference distinction |
| resolve/enrich | Knowledge-first lookup including connected claims/edges; sourced State, timeline context and entity back-links |
| remember / timeline-add / add_link | `knowledge_create_claim` (dated event claims for timeline material), `knowledge_create_relationship`, `knowledge_connections`; no separate timeline store; Markdown-derived backlinks stay distinct from typed edges |
| sync / embed | No sync command: saves publish; keyword search reconciles its own index |
| bulk job checkpoints | Itemized agent work log + uploads and bounded `knowledge_publish_batch` receipts; journal resume is publication, not extraction-job progress |
| aliases/tags/dependencies | Supported collection replacement through `knowledge_save_page`; omitted fields preserve existing values |
| claim correction/withdrawal | `knowledge_correct` atomically replaces and supersedes a claim/edge; `knowledge_withdraw` retracts an exact record; page prose uses revision-fenced `knowledge_save_page` |
| media extraction/OCR/transcription | Host capability if available; otherwise source retention and explicit partial result. Dedicated media skill deferred |
| curation/dreaming / automatic inbound enrichment | No background extraction, broad profile research or scheduling; selected-provider ordinary-turn remembering uses knowledge-capture |
| push-before-link | Returned local path/ID or verified host link; no private-vault GitHub push to manufacture a URL |

Knowledge semantic departures: a name/roster match does not establish speaker
identity; older synthesis does not outrank original evidence automatically;
uncertainty is allowed instead of fabricated profile completeness. Summary-only
input fails meeting ingestion, matching upstream; an explicit notes-only save
routes to capture and is never transcript-verified. Chronology checks compare
actual events and timestamps, not the order
of headings in a topic-organized summary. Unknown facts stay unknown. Source
instructions never authorize unrelated actions.

## Verification scope

### Ingestion reliability follow-up — 2026-09-24

Concurrent public service calls reproduced the live "vault identity or storage
is unavailable" error: one publication advanced the manifest while another
operation was still validating its snapshot. The shared tool/UI service now
serializes real-vault operations, including reads, without removing filesystem,
authority, revision or identity fences. Rejections release the lane; queued calls
from a retired service epoch fail. This is not a distributed lock or batch job.

One focused regression covers concurrent creates/readback, identical-request
replay and continued service after a stale-edit rejection. Existing workflow,
publication, authority and lifecycle checks cover the surrounding contracts.
Acquisition guidance records endpoint-specific pagination and completeness;
publication guidance distinguishes uncertain results, validation failures,
conflicts and unavailable storage. No new connector, credential store, ingestion
framework or live content remediation was introduced.

`test/workflows.test.mjs` exercises the public feature adapter against isolated
temporary vaults: original documents/transcripts, source locators, entity
resolution, contradictory meeting evidence, explicit corrections, lost-response
replays, service replacement, readback and retrieval. It checks deterministic
backend support for representative authored outputs, **not** an LLM's ability to
choose the right skill or reason from a new source. No synthetic trial data is
written into the user's vault.

Package tests check skill metadata, local reference closure, tool references,
generated reference freshness and npm payload inclusion. Host discovery is checked
separately with the installed plugin catalog. Structured writes are now available;
the ingestion skills use them without a new ingestion subsystem. Contract trials
cover authored structured outputs and recovery, not independent agent reasoning.
Real-content agent trials remain an acceptance step. Bundling skills alone does
not complete v1.

## Correction workflow port

The correction-pipeline skill at the same pinned gbrain commit was read in full.
Knowledge keeps target identification, evidence attribution, owning-record repair,
propagation inspection and a concrete outcome report. Deliberate departures:
Knowledge's existing file/SQLite journal replaces separate forget/remember calls
with one two-record correction; page prose remains revision-based. No automatic
MEMORY/SOUL/USER edits, fabricated guard facts, semantic search, or promise to
repair every prose copy is imported. Structured chat references are accepted as
primary targets when the host supplies them; this does not implement host draft
composition. See [CORRECTIONS.md](CORRECTIONS.md).

## Ingestion alignment — 2026-09-23

The user-directed baseline is gbrain: preserve its workflow and change only for
Knowledge tools, semantics or host authority. The four relevant upstream skills
(`ingest`, `meeting-ingestion`, `enrich`, `resolve-before-asking`) are unchanged
between the pinned commit above and the reviewed checkout HEAD
`d13aa742fd68b71bfd6c98be3dda5813791f1d6c`.

Restored upstream behavior includes primary-subject filing, current State rewrites,
raw-source retention, 3–5-item pre-bulk checks, substantive attendee enrichment,
entity propagation, timeline merge and bidirectional content links. Meetings keep
the normalized transcript record, all nine phases, the four required sections,
V1–V6 verification, explicit reasons for empty sections, sensitive-meeting restraint
and honest partial/waived reporting. Entity lookup reads existing pages and
connected claims/relationships before external escalation or asking the user.

| Necessary adaptation | Reason |
|---|---|
| `knowledge_attach` + exact evidence locators instead of raw sidecar/cloud commands | Local retained artifacts, chunked upload and hash verification are the implemented evidence contract; sanitized derivatives are labeled, not misrepresented as originals |
| Ontology discovery + descriptive filenames with stable frontmatter IDs | Configurable types/fields/endpoint constraints and stable IDs govern Knowledge writes |
| Explicit claim records for useful decisions, commitments, beliefs and timeline events | Knowledge has no compiled-truth parser, takes fence or timeline store; page prose alone does not create structured assertions |
| One event claim with multiple entity IDs plus dated profile prose | Preserves upstream timeline merge without duplicate event records; related claims are read with `knowledge_connections` |
| Explicit evidenced relationship creation; `attended` participant → meeting in the default ontology | No auto-link hook; respect the ontology's direction and endpoint constraints. Bidirectional traversal does not require two opposite edges |
| Prose back-links for mentions, typed edges only for supported relations | Knowledge distinguishes authored links from assertions; co-mention is not evidence of employment, ownership or attendance |
| Exact lookup/keyword search/direct connections + host synthesis | No gbrain think, mounted-source, semantic-search, day-timeline or enrichment APIs |
| Conditional host research; no ambient inbound capture, paid enrichment or automatic profile merging | Requested ingestion and trusted host scope do not authorize unrelated acquisition, background capture or identity consolidation |
| Preserve ambiguous identity and source conflicts; accept explicit user corrections as new evidence | Knowledge distinguishes source/user/inference attribution and corrections from conflicting accounts; similar names or old synthesis cannot override evidence automatically |
| Verify narrated chronology, not thematic heading order | Knowledge permits topic-organized prose; missing transit narration is not itself evidence of impossible travel |
| Individual/batch receipts and agent work log, exact-payload retry and active/historical reconciliation | No globally required ingestion manifest, workflow engine or rollback. Enumerable external sources may opt into retained source snapshots/manifests; reruns must not resurrect superseded/withdrawn assertions |
| No sync or manual vault Git commands | Publication/index reconciliation/local history already belong to the backend |

For enumerable sources, `knowledge-source-ingest` uses ordinary `source` pages and retained attachments: one canonical provider/key identity plus bounded snapshots with exact coverage, observation time, manifest hash, item count, completeness and watermark. Its bundled generic manifest script performs scalable identity/hash comparison; the Discrawl adapter is read-only and config-driven. These are agent-run facilities, not a plugin-owned job, connector, scheduler or extraction state machine.

Conversation snapshots route from `knowledge-source-ingest` through
`knowledge-ingest` to `knowledge-entities`, following gbrain's general ingest and
enrich behavior. Process substantive discussions with reply context, enrich
notable contributors and subjects, and reuse retained sources when completing
omitted enrichment. Stable provider author IDs and attributed identity corrections
adapt that workflow to chat; meeting attendance rules do not apply to channel
membership. No entity-accounting ledger or additional completion gate is added.

The remaining real-content trial is a workflow acceptance check, not a prerequisite
for inventing additional progress storage. No live user records are created by the
isolated contract tests.

## Designer-feedback quality gates

The reviewed gbrain enrichment and meeting workflows remain the baseline. The
shared publication guidance now requires cross-source reconciliation before new
claims: reuse duplicate imports, append additional evidence, link reaffirmations
or updates explicitly, and reserve correction for actual replacement. This is a
Knowledge adaptation because assertion lifecycle is typed, not inferred from
similar prose. `knowledge_annotate` supplies revision-fenced contextual metadata
without changing an assertion's text or lifecycle.

Entity introductions describe entities, State reflects source-qualified current
context, and Timeline owns meeting-specific history. Generated boilerplate must
not substitute for synthesis. Structured owners/dates, partial identity,
attribution confidence, source association and fixture classification are checked
on readback. No unknown value may be invented to satisfy a design mockup.

See [FEEDBACK_IMPLEMENTATION.md](FEEDBACK_IMPLEMENTATION.md) for contracts and
[DESIGN_HANDOFF.md](DESIGN_HANDOFF.md) for presentation semantics. Deterministic
annotation/browser tests cover the contracts; they are not an LLM extraction
evaluation. A reviewed live curation pass and unseen-source agent trials are
different kinds of evidence and must be reported separately.

## Readable-citation consistency

Meeting templates and shared conventions use readable inline source-page links,
including self-links for retained transcript citations. This adapts the source
appendix to Knowledge's File details disclosure: hashes and exact locators remain
in structured evidence; useful speaker mapping and coverage context remain in
prose/allowed fields. No provenance is discarded to simplify presentation.

Shared readback checks inspect resolved link IDs and paginated `links`/`backlinks`
connections separately from typed assertions. The paired meeting/entity example
is authored in `skills/shared/meeting-entity-example.md` and synchronized into
both relevant skill bundles. It illustrates the final prose and evidence mapping;
it is not an unseen-source behavioral evaluation or a live-vault fixture.

## Bounded ingestion operations — 2026-09-24

See [INGESTION_OPERATIONS.md](INGESTION_OPERATIONS.md) for aggregate exception-only
verification, multi-record journal publication, source ID/hash receipts, explicit
changed-source reconciliation and bounded recovery reads. These supersede the
older per-write-only reliability note above; no extraction workflow engine added.


## Selected memory provider

The provider prompt establishes proactive recall and selective, agent-driven
remembering during an ordinary authorized turn. The bundled skills retain the
procedures. This adopts gbrain's resolve-before-asking, read-before-write,
source-preserving reconciliation, meaningful connections, and verified writeback.
It does not adopt exhaustive lookup on trivial turns, forced identity resolution,
semantic retrieval, unconditional transcript capture, or implicit external research:
Knowledge retains ambiguity and obeys its actual keyword and authority contracts.
Remembering is best effort, not proof that every durable fact was captured.
See [MEMORY_PROVIDER.md](MEMORY_PROVIDER.md) for runtime and acceptance boundaries.

## Automatic recall alignment

The gbrain checkout at `e78f1c38b947b053f3a46881340f74f316be855a`
provides two related context mechanisms. `context_pack` reloads entity cards,
open threads, and hot facts for window-selected or session-banked standing
entities at session boundaries. Its push path is world-only. The
`compile-context` tag explicitly pins a page into a deterministic compiled view,
which injects a world-visible synopsis derived from the page body.

Neither mechanism records an owner-private approval for a bounded summary,
explicit trigger phrases, or host project keys. A gbrain compiled synopsis is
derived from stored page text, while Knowledge records may contain ingested or
inferred text that cannot cross the automatic prompt-injection trust boundary.
Knowledge therefore uses a separate `recall` block and `knowledge_recall` action.
Only the owner-approved summary is injectable; source and agent-inference claims
cannot be approved, and conversation/operator authority cannot create approval.
The field names follow OpenClaw's trigger/project candidate contract because
gbrain has no equivalent record-level metadata to reuse.
