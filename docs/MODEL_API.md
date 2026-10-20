# Model-facing inspection

The UI and agent tools use the same typed service and access checks. These are
presentation choices, not alternate authority or storage paths. All options below
are live service inputs once the rebuilt plugin is loaded. Existing callers must
opt into fields that used to be returned unconditionally.

## Stores

Every tool acts on the calling agent's effective knowledge store: its own store,
or a named store it is assigned to. Tools take no store, agent, path or scope
argument, and the store is resolved from the host-minted audience on every call.
A never-used store is created on the agent's first knowledge operation. Store
assignment (`stores_*`) and the operator viewing proxy (`agent_query`,
`agent_action`) are operator operations, not tools.

## Ontology: discover, then inspect

| Task | Input to `knowledge_ontology` | Output |
|---|---|---|
| Discover vocabulary | `{}` | Catalog: names, labels, kinds, descriptions, aliases, record counts; 50 entries/page |
| Prepare a page write | `{"view":"definitions","name":"project"}` | Structured fields, allowed values, filing, endpoint constraints and provenance; no serialized JSON copy |
| Browse a kind | `{"kind":"page","limit":20}` | Filtered catalog with `nextOffset` |
| See examples | `{"view":"definitions","name":"project","includeRecords":true}` | At most 20 record summaries/type and an explicit `recordsTruncated` flag; exhaustive retrieval uses `knowledge_records({type:"project"})` |
| Discover source files | `{"view":"sources"}` | Authorized source paths, validity and size, without raw YAML |
| Debug a manifest | `{"view":"sources","sourcePath":"ontology.yaml"}` | Only the selected YAML, bounded to 12,000 characters by default |
| Diagnose activation | `{"view":"diagnostics"}` | Paginated issues and inheritance chain |

Definitions default to 10/page; other list views to 50/page. `limit` accepts 1–100.
`name` is exact; `kind` is page or relationship. All views include availability,
identity/fingerprint, total count, offset and nextOffset. `totalIssues` is the
vault validation count, not just activation errors. Unavailable ontology is not
reported as a valid empty vocabulary.

Follow `nextOffset` with unchanged view/filters. Source text offsets count
characters; other offsets count entries. A selected source reports `total` in
characters and repeats that unit explicitly as `source.totalChars`. `maxChars`
accepts 256–65,536. Source paths must match already-enumerated authorized sources;
this is not a filesystem-read tool. Compare fingerprints across definition pages.

Raw YAML is useful only for diagnosing malformed definitions or preserving authored
comments during a source edit. It is not needed for normal page authoring. Effective
definitions are already structured; there is no model-facing serialized-definition
mode. Behavior flags describe vocabulary and do not enable unimplemented workflows.

## Records: content once, extras on request

`knowledge_record({id})` returns body text, identity, revision/hash, lifecycle, attribution/assertion origin when present, validation issues and compact structured metadata (owner/dates, associations, endpoints, attribution and identity uncertainty). It does **not** return original Markdown a second time, full frontmatter, evidence descriptors/excerpts,
or connected-record lists by default.

- `view: "summary"`: omit text and evidence by default; inspect identity/state.
- `view: "raw"`: original Markdown **instead of** body, for exact-file inspection.
- `metadataView: "compact"` (default): structured associations, dates, endpoints, aliases, domain fields, version links and uncertainty, without evidence descriptors.
- `metadataView: "none"`: omit structured metadata.
- `metadataView: "full"`: full frontmatter as a structured object, not a JSON string.
  When the expanded evidence list would exceed the response budget it is dropped and `omitted` lists `metadata.evidence`; page evidence with `includeEvidence` instead.
  Omitting `fields` from a save preserves existing fields. Legacy `includeMetadata: true/false` selects full/none; combining it with `metadataView` is an error.
- `includeReferences: true`: connected summaries, default 20/page, with
  `referenceTotal` and `nextReferenceOffset`. Continue with `referenceOffset`;
  `referenceLimit` accepts 1–100.
- `evidenceOffset` / `evidenceLimit`: page through source references (default 20, max 100 **per response**, not per record), following `nextEvidenceOffset`; `evidenceTotal` reports the full count.
- `includeEvidence: true`: opt into verified citation locators, source previews and related statements for provenance review (off by default in all views). `maxEvidenceChars` limits the
  **combined excerpt text** (default 4,000; range 0–20,000). Citation locators and
  verification remain present even if excerpts are shortened; each excerpt has
  `excerptTruncated`. Verification describes the full locator, not just its excerpt.
- `offset` and `maxChars`: page through body/raw text (default 12,000 chars).
  Follow `content.nextOffset`; `content.totalChars` discloses the full length.
  Compare hashes across chunks and restart if the record changes. Never replace a
  page using an incomplete body. Missing/duplicate IDs return `record: null`.

Complete record responses are limited to 24 KiB of serialized UTF-8 JSON. Text,
evidence and references may return smaller pages; always use returned continuation
offsets, not requested lengths. Supplemental previews excluded to fit are named in
`omitted`; inspect connections, attachments or paged raw text for complete detail.
Oversized metadata or individual evidence items produce a small explicit error,
not broken JSON or silently truncated metadata. Use `view: "raw", metadataView: "none"`
without evidence/references to read the original file in bounded chunks.
The browser explicitly requests rich metadata and evidence for inspection. These
are response projections, not storage changes or permission to skip source review.

## Durable capacity and bounded transport

A complete record, including frontmatter, may occupy **5,000,000 UTF-8 bytes**.
This is a storage ceiling, not a recommended profile size or tool-response budget.
Save, annotation, recall, lifecycle, evidence reconciliation, guarded record reads
and journal publication enforce the same limit. Leave headroom for revision and
lifecycle metadata. Oversized changes fail without replacing the current record.
Ontology/manifests, source descriptors, attachment chunks, batch requests and
responses retain separate limits.

A single save/claim/relationship body or body-edit replacement remains limited to
48,000 characters. This is deliberately a bounded input, not the maximum stored
body. Record content offsets count UTF-16 code units, not UTF-8 bytes; returned
continuations preserve surrogate pairs. The complete record response stays within
24 KiB. Runtime status exposes these limits independently of tool discovery.
Automatic-recall project keys have an independent 500-character limit; candidate
responses are byte/node-budgeted before and after provider adaptation. They report
partial coverage when validation, requested limits or response budgets omit rows.
Line-based provider reads accept continuations throughout the durable capacity.

### Edit a small range in a large page

Use knowledge_edit_body for an authorized active-page body change:
- Read relevant knowledge_record content windows, checking a consistent hash.
  Inspect surrounding context and source support; a local edit is not permission
  to skip the semantic review required for entity synthesis.
- Supply observed expectedVaultId, expectedRevision, expectedHash, and
  expectedOntologyFingerprint, the record ID, a fresh mutation UUID and reason.
- start is inclusive and end exclusive in the full **body**, not raw
  frontmatter or a response chunk. Equal offsets insert; empty replacement deletes.
  No fuzzy matching or automatic rebasing. Invalid ranges and broken Unicode fail.
- Unchanged prose, metadata, evidence, source descriptors and other records remain.
  The change publishes a normal revision with body_change audit metadata.
- Retain the exact request. After uncertainty replay the identical UUID/payload.
  After a stale-fence rejection, reread and reconcile before using a new UUID.

Small edits use the existing publication journal and recovery, not a second writer
or a server-side draft protocol. Each call is a complete revision. Incremental
appends can grow a record, but are **not** a cheap bulk-upload mechanism: retained
history and publication work still scale with the whole record. Use attachments
for long source originals; capacity does not justify copying transcripts into profiles.
Claims and relationships continue to use their explicit correction workflow.

### Historical and recovery text

knowledge_revision returns a bounded raw window and content with offset,
totalChars and nextOffset. Continue with the same sequence and returned offset.
knowledge_mutation retains file-list pagination separately. Keep that file
offset fixed and use contentField (before/proposed/displaced; default proposed)
and charOffset to continue the selected file text. Each field has its own
content total/nextOffset/hash; compare hashes across windows and restart if changed.
The other fields return their opening windows. Receipt-only checks still use
includeFiles:false. A missing receipt is not proof an upload is absent.

The UI loads additional notes only on request, reparses accumulated Markdown so
comments/code fences survive page boundaries, and rejects mixed revisions. Shared
memory line reads never silently skip an oversized line: they direct callers to
character-paginated knowledge_record when a line cannot fit their transport.

### Search on large records

Full-record FTS matching, column matches, filters and BM25 ranking are unchanged.
For bodies above 65,536 UTF-8 bytes, previews are bounded **opening excerpts**,
not located match excerpts; snippet.matchLocated:false and the UI disclose this.
This avoids the measured repeated-match cost of full-document FTS5 highlighting.
Open the cited record and verify its hash to inspect content; do not treat the
opening excerpt as proof of where a query matched. Smaller-record highlighting
is unchanged.

### Cost and limits of the measurement

Run node --expose-gc scripts/measure-record-capacity.mjs after compilation.
It uses synthetic isolated vaults, real Git publication and keyword indexes, never
production profiles. On October 8, 2026 (Node 26.8.1), a roughly 4.95 MB repeated-
paragraph record measured: cold scan 430 ms, warm scan 2.6 ms, small body edit with
Git 952 ms, content read 193 ms, initial indexed search 73 ms, warm search 17 ms.
Before bounding highlighting, that same search workload took approximately 23 s.
Record/revision responses stayed near 13 KB; recovery response near 38 KB.

These are individual local observations, not latency guarantees or a vault-scale
benchmark. The process high-water RSS was about 422 MiB across the sequential run;
the near-limit fixture's SQLite file reached about 85.5 MB after retained revisions,
journal and index work. Full snapshots amplify storage and transient allocation.
The new limit does not promise constant-cost edits, unlimited records, or efficient
bulk transfer of multi-megabyte bodies. No caches or dependency upgrades were added.

## Drafts and publication are different

One unsaved browser draft per authorized agent/vault/scope is retained in tab-local
sessionStorage on each edit. It survives navigation, page reload and plugin UI
remount. Original record ID/revision/hash and the exact submitted payload/request
ID survive uncertain save outcomes. A recovered draft never replaces its edit
preconditions with a newer snapshot. Opening another editor reopens the existing
draft; explicit discard is available only before acceptance/uncertain submission.

This is not a server draft or backup. Closing the tab, clearing browser storage,
or browser failure can lose it. Storage errors remain visible. Drafts open only
after an authorized status response for the same identity; browser saves include
`expectedVaultId`, a precondition (not a scope selector), to reject accidental
publication into a replacement vault. No new scope authority is granted.

An **accepted publication** has durable intent and recovery material. The journal
exists because Markdown/artifacts and SQLite cannot share one transaction. Use the
same request ID and exact payload for retries, and inspect/resume accepted work.

A request rejected **before acceptance**, including a stale revision/hash, creates
no saved draft or receipt. The error says so. Keep the proposed text, read the
current record, reconcile, and submit a new request. Do not archive every invalid
request just to make a misleading error true.

## Pre-compaction save request IDs

`knowledge_save_page.requestId` is optional only when the host invokes the tool
with a pre-compaction `memoryFlush.flushId`. Knowledge derives a lowercase UUIDv8
from SHA-256 of that flush ID and the normalized page title. The same flush and
title therefore replay the same publication intent: an identical payload returns
the original receipt, while a changed payload is rejected as a request-ID reuse.
Different titles or later flush IDs derive different IDs.

`knowledge_remember.requestId` follows the same rule. It derives the ID from the
flush ID and the call's claim texts joined by newlines.

Normal agent calls and browser saves must supply a lowercase UUID. A supplied ID
is used unchanged during a flush. The host-delegated audience still selects the
agent-private or exact conversation partition; omitting the ID grants no scope.

## Local Git history

`knowledge_save_page` and `knowledge_resume` return publication status separately from optional `git: {state, commit?, message}`. A `published` receipt remains a successful save even when Git is `pending` or `unavailable`. `committed` includes the local commit ID. Retry with the same request ID; do not resubmit a new write just to get a Git checkpoint.

`knowledge_history` adds a scoped `git: {state, pending, message}` summary. States also include `idle` (no content observed yet) and `read-only`. Neither counts nor retries include other scopes. Normal scoped scans also retry queued history. No GitHub or remote operations are exposed. See [local-history details](LOCAL_HISTORY.md).

## Automatic recall approval

`knowledge_recall` is an owner-private agent action. It accepts one exact target:

```json
{
  "requestId": "lowercase-uuid",
  "id": "record-id",
  "expectedRevision": 3,
  "expectedHash": "sha256",
  "set": {
    "summary": "Prefer concise implementation reports with exact proof.",
    "triggers": ["implementation report"],
    "importance": 8,
    "projects": ["github.com/openclaw/knowledge"]
  }
}
```

Use `"clear": true` in place of `set` to remove recall metadata. The two forms
are mutually exclusive. Set requests require an active, valid, available target.
Claims with `assertion_origin: source` or `agent_inference` are rejected because
externally sourced or inferred text is not approved owner context. Clear remains
available for any eligible target.

The action requires writes to be enabled, `context.source: tool`, and a current
owner-private host audience. Conversation audiences, browser/session actions,
operators, and sample mode cannot approve automatic recall. The service writes
`approved_by: owner-private` and `approved_at`; neither is accepted from the
caller. The action uses the standard publication journal, exact-payload replay,
revision/hash conflict checks, receipt, and local Git checkpoint behavior.

Corrections do not inherit approval. Inspect the replacement and issue a new
`knowledge_recall` request only after the owner approves its summary.

## Keyword retrieval and exact identity lookup

`knowledge_grep({query})` ranks titles, aliases and authored bodies with local
SQLite FTS5. Modes: `all` (default, every word), `any`, `phrase`; not regex/raw FTS.
`knowledge_lookup({query})` resolves exact IDs, full names and aliases, returning
`found`, `ambiguous` or `missing`. Never infer identity from the first ambiguous hit.

Both default to **active** valid records. Saved pages are immediately available;
there is no approval status or acceptance filter. `lifecycle:"superseded"` or `"all"`
includes historical records, never withdrawals. Both accept `kind`, `type` (ontology
aliases supported), exact `tag`, `limit` (1–50, default 20), and `offset`.

Hits contain bounded snippets, matched fields, revision/hash citations and up to
three verified evidence locators. Inspect with `knowledge_record` for more.
Keyword `index.state:"unavailable"` / `total:null` is a failed retrieval, not zero
matches; retry or inspect the database. `coverage.complete:false` signals source
validation issues. Compare `index.snapshot` across pages and restart if changed.
Exact lookup does not depend on FTS. `knowledge_records` remains exhaustive
listing, including records needing inspection; search is not an inventory.

Publication receipts describe publication-time state: `indexed:false` now means
pending until the next search reconciles. Search reports its own current snapshot.
See [retrieval semantics, security and rebuild boundaries](RETRIEVAL.md).

## Live state

The private-vault explorer subscribes to the supported `changed` feature event.
Events contain no record data or paths. Node filesystem watches coalesce hints;
normal authorized scans perform reconciliation and Git checkpointing. They do not
create a background identity with broader access or scan other conversations.
Reconnect, manual refresh, and a 30-second visible-page fallback request current
snapshots, covering missed/coalesced notifications and backend-only reloads.
`status.live` reports `watching`, `unavailable`, or `stopped`; unavailable watchers
are retried on the next authorized private status read. Conversation tools still
reconcile their own partition on demand; they do not run private reconciliation.

Service stop closes watchers/timers and fences old and in-flight access. A retry
uses the original request ID against the replacement service; accepted publication
recovery and explicit conflict handling remain unchanged. Full backup/restore is
not implemented by this lifecycle work.

## File attachments

Use `knowledge_attach` to retain original source bytes (text, PDF, image, audio,
video or other files). Send sequential base64 chunks with a stable requestId,
filename, mediaType, attribution, byte offset and final flag. Each decoded chunk
is at most 48 KiB to fit the native transport; this is **not** a total file-size
limit. Retry identical chunks with unchanged metadata after interruption.
The complete receipt returns `evidence`; append it with `save_page.attachments`.
There is no evidence-count cap. Pages can still be saved without any evidence.

`knowledge_attachment({id,path,sha256,offset})` downloads originals referenced by
an authorized record, one base64 chunk at a time. Follow nextOffset until null.
Never mistake the bounded excerpt for the original. No tool accepts an arbitrary
host filesystem path. Older source.text saves remain supported, without the old
48,000-character schema cap; file upload is the normal authoring interface.

The editor selects multiple files, retains completed uploads in draft recovery,
and offers downloads from record detail. Browsers cannot restore an unuploaded
File selection after reload: reselect those files. Completed originals remain in
the vault even if the page draft is discarded. See [EVIDENCE.md](EVIDENCE.md).

## Remembering claims

`knowledge_remember` is the cheap capture path for discrete
conversation-derived claims. One call takes these fields:
- a short `attribution`,
- the supporting conversation `excerpt` (at most 16 KiB),
- 1–20 `items`. Each item has `text`, a claim `kind`, an optional `subject`,
  an `origin` of `source` (default) or `user_belief`, and optional dates.

Agent inference is rejected. The call needs no prior search, upload, ontology
fingerprint or readback.

```json
{
  "requestId": "00000000-0000-4000-8000-000000000020",
  "attribution": "user in openclaw session 8f3a, 2026-10-19",
  "excerpt": "User: use option B, it ships sooner.",
  "items": [{ "text": "Chose option B because it ships sooner.", "kind": "decision", "subject": "Garden Pilot" }]
}
```

The server takes these steps:
1. **Resolve each subject** with exact lookup, the same rule as
   `knowledge_lookup` (page ID, title or alias, active pages only, merge
   redirects followed).
   - A unique match puts the page in the claim's `entities`.
   - An ambiguous or missing match saves the claim unlinked and returns
     `subject: ambiguous | missing`, with candidate pages for an ambiguous match.
   - No page is ever created.
2. **Find exact repeats.** An item is a repeat when an active claim already has
   the same normalized text, the same kind and the same linked subjects. An
   earlier item in the same call also counts. A repeat returns
   `status: duplicate` with the existing ID and writes nothing.
3. **Retain the excerpt.** It is stored through the attachment service as
   `artifacts/<requestId>/excerpt.txt`. Every inserted claim cites it by path,
   hash and line range.
4. **Publish.** The inserted claims go out as one journaled batch with one
   receipt. A call where every item is a duplicate returns `receipt: null`.

Retrying the same request ID with the same payload returns the original
results. Reusing it with a different payload is rejected.

Claims link to pages through `entities` only. The page view already lists the
claims linked to it. Page prose is never rewritten, and to revise it you use
`knowledge-capture`.

## Structured authoring

1. Read `knowledge_status` and `knowledge_ontology`; retain the vault ID and
   effective ontology `fingerprint`. Resolve existing pages with lookup/records.
2. Retain source bytes using `knowledge_attach`, or reuse evidence from an
   authorized source record. Add only locators/quotes verified against that source.
3. Publish through the operations below; use fresh UUIDs for genuinely new writes
   and exact request/payload replay for uncertain outcomes. Publication is not
   semantic truth, extraction completeness, deduplication or task execution.

`knowledge_create_claim` example (replace symbolic UUIDs/fingerprint/evidence):

```json
{
  "requestId": "<new UUID>",
  "expectedVaultId": "<observed vault UUID>",
  "expectedOntologyFingerprint": "<ontology fingerprint>",
  "title": "Release commitment",
  "body": "Alex committed to delivering the release on Friday.",
  "claim_kind": "commitment",
  "assertion_origin": "source",
  "attribution": "Alex, meeting transcript line 12",
  "entities": ["<project page ID>"],
  "dependencies": ["<meeting page ID>"],
  "owner": "<resolved person page ID>",
  "due_at": "2026-09-25",
  "evidence": [{"path": "<retained artifact path>", "sha256": "<observed hash>", "start_line": 12, "end_line": 12}]
}
```

Kinds: fact/preference/decision/commitment/event/belief. Origins:
source/user_belief/agent_inference. Omit unknown owners/dates. For a timeline event,
use an event claim with `occurred_at` and relevant entity IDs. There is no dedicated
chronological timeline query yet; inspect connected claims and their dates.

`knowledge_create_relationship` uses the same request/vault/ontology controls,
title/body/attribution/evidence/dependencies and optional validity/expiry, plus
`from`, `to`, ontology `label`, and optional ontology `fields`. It does not accept
claim kind/origin, occurrence or commitment fields. Inspect endpoint constraints
before publication; backend enforces them. Same endpoint pair may carry multiple
independently evidenced assertions. No implicit supersession or overwrite.

`knowledge_save_page` additionally accepts aliases/tags/dependencies and optional
`expectedOntologyFingerprint`. Omission preserves metadata; supplied collections
replace (empty clears). Existing ID/revision/hash edit preconditions still apply.

All three operations share accepted/published/conflict receipts, request replay,
resume/history/Git behavior, service-generation fencing and live refresh. Changed
payload or operation under an existing request ID fails. Creates generate their
own ID/path. These create APIs do not overwrite assertions. Use `knowledge_correct` and
`knowledge_withdraw` for explicit lifecycle changes; see [CORRECTIONS.md](CORRECTIONS.md).

`knowledge_connections({id})` defaults to compact identities, directions, typed
endpoints and identity/attribution uncertainty. It omits evidence descriptors,
paths, timestamps and card bodies. `view:"full"` adds those record details and up
to three evidence references (`evidenceTruncated` signals more). Use
`includeCards:true` with full view for claim prose, or `knowledge_record` for
complete provenance. `includeEndpoints:true` adds deduplicated endpoint identities
in the selected view. The UI explicitly requests full view for its rich cards.

Directions: `incoming`/`outgoing` typed relationships, `dependents`, `claims`,
`links` authored Markdown references, and `backlinks` derived reverse navigation.
A backlink does not prove an authored link in the opposite direction. Default
20 rows, max 100; the complete JSON response is bounded to 24 KiB, so a page may
be shorter. Follow `nextOffset` (actual rows returned), keeping filters and view
unchanged, and compare `snapshot`. Access and active eligibility precede counts.
`historical:true` includes inactive/superseded, never withdrawn records. An
oversized single full row returns an explicit error; use compact mode and inspect
that record separately. Rows are never silently skipped or cut mid-JSON.

Browse (`knowledge_records`) and Recent bound the entire response by both UTF-8
bytes and nested JSON values, not just row count. Pages may be shorter than the
requested limit: follow `nextOffset` for Browse and `nextBefore`/`nextRecordOffset`
for Recent. An individually oversized card is returned as a navigable summary;
inspect `knowledge_record` for its full text and provenance. Attribution level
and basis remain visible even when evidence previews are omitted to fit.

`includeEndpoints:true` adds deduplicated, currently eligible endpoint summaries
for only the returned connection page. Historical edges never expose withdrawn
or ambiguous endpoints. The Recent feature query supports the same option on
each returned source group (at most 40 endpoint summaries for 20 records),
including `recordOffset` continuation pages. The inspector uses these projections
instead of issuing one record read per relationship or attendee. Page content
renders independently of secondary connections/history; late panel responses
remain fenced to their original navigation generation.

Native UI offers New claim/New relationship alongside New page. Advanced source
controls accept file uploads or existing evidence with exact locators. Drafts
retain operation kind, all form values and exact submitted payload/preconditions;
failed authoring-option loads can be explicitly retried without losing a draft.

## Corrections and withdrawal

`knowledge_correct` requires the target ID, current revision/hash, nonblank reason,
current ontology fingerprint, and a complete same-kind `replacement`. One receipt
identifies the superseded target and new record, with known dependency impact.
`knowledge_withdraw` retracts one exact page/claim/relationship, without deleting
history or source files. Both are agent-only operations; browser requests are
rejected. Repeat identical request IDs/payloads after an uncertain response.

Default records/ontology/status counts now describe current eligible knowledge.
`knowledge_records({lifecycle:"all"})` explicitly requests historical inventory.
Use exact record metadata and history for obsolete assertions and withdrawal
reasons; inactive dependencies are not automatically repaired. The complete
portable/recovery/access contract is in [CORRECTIONS.md](CORRECTIONS.md).

## Ingestion operations

See [INGESTION_OPERATIONS.md](INGESTION_OPERATIONS.md) for `knowledge_verify`,
`knowledge_publish_batch`, `knowledge_source_check`, local batch references,
source replay/reconciliation, and bounded mutation recovery.

## Temporal retrieval

Chronicle tools and time filters are documented in [Temporal retrieval](TEMPORAL.md). Use knowledge_timeline, knowledge_chronicle_day, knowledge_chronicle_since and knowledge_chronicle_last_seen for structured dated records. knowledge_grep/knowledge_records accept timeField/since/until. No new watcher or dreaming is required.

## Source passage reads

knowledge_evidence_read accepts id, path and sha256 from a record's retained
source locator, with optional inclusive startLine/endLine. It returns UTF-8 text,
normalizing CRLF to LF, a verified source hash/range, and nextCursor. Pass that
cursor with the same id/path/sha256; omit line bounds or repeat them exactly.
maxChars defaults to 3000 (256–3000). Pages never split Unicode scalar values;
long single lines continue by character position. nextCursor=null means the
requested passage is complete. nextEvidenceOffset on knowledge_record instead
pages the citation list; excerptTruncated means an excerpt is incomplete even
when that list has ended. Hash/range verification does not evaluate interpretation.

Each passage read reauthorizes the record and file and validates the complete
source bytes. Source or range mismatch rejects; restart with an observed locator.
Binary sources use knowledge_attachment. The reader cannot access arbitrary
files, unreferenced sources or withdrawn records. A sourceFiles entry aggregated
from a related claim must be read using that citing claim ID, unless the page
also directly cites it. Primary and annotation citations on the record are
accepted; related-record membership alone does not grant source access.
Source reading remains part of
semantic review; aggregate verification does not replace it.

Search, lookup, inventory and temporal query responses use freshness.queriedAt
and freshness.scannedAt instead of checkedAt. Successful keyword queries also
expose freshness.indexedAt, moved from index.indexedAt. Status and diagnostic
checkedAt fields continue to describe their scan/status observation.
